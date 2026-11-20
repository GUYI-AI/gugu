import { anySignal } from '@gugu/core/shared/anySignal';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import {
  appendAgentHomeHistory, ensureAgentHome, planAgentHomeHistory, resolveAgentHome,
} from '@gugu/session-core/agents/plugins/helpers';
import { appScope } from '@main/app/app-scope';
import { resolveAgentHomeRoot } from '@main/core/agents/agent-home';
import { prepareManagedCodexHistory } from '@main/core/agents/managed-codex-history';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { sessions } from '@main/db/schema';
import { loginShellEnv } from '@main/utils/userEnv';
import type { CodexTaskScan, CodexTaskImportResult, CodexTaskSourceRow, ImportCodexTaskParams } from '@shared/core/session-import/codex-tasks';
import { bindLocalSession } from './import-local-session';
import { readCodexTasks, verifyCodexTaskFiles } from './codex-task-process';

const closing = new AbortController();
appScope.add(() => closing.abort());
let running: AbortController | undefined;
let preparation: { phase: 'copying' | 'history' | 'binding'; startedAt: number } | null = null;
const ledger = new KV<Record<string, { revision: string; path: string; state: 'copied' | 'prepared' | 'bound'; sessionId?: string }>>('codex-task-import');
let scanning: Promise<CodexTaskScan> | undefined;

function homeForTasks() {
  const bundle = pluginRegistry.get('codex')?.capabilities.sessionBundle;
  if (!bundle?.configRoot) throw new Error('本机未提供 ChatGPT 导入');
  const home = resolveAgentHome({ providerId: 'codex', injectionMode: bundle.injectionMode, configRoot: bundle.configRoot,
    guguHome: process.env.GUGU_HOME ?? '', osHomeDir: homedir(), sourceEnv: { ...process.env, ...loginShellEnv() } });
  if (!home) throw new Error('本机未提供 ChatGPT 导入');
  return home;
}

export function scanCodexTaskImport() {
  scanning ??= readCodexTasks(homeForTasks().userConfigRoot, closing.signal).finally(() => { scanning = undefined; });
  return scanning;
}
export function codexTaskImportProgress() { return preparation; }
export function cancelCodexTaskImport() { running?.abort(); }

/** Only source IDs/revisions cross RPC; paths/cwd/native IDs are reread by the host. */
export async function importCodexTasks(params: readonly ImportCodexTaskParams[]): Promise<CodexTaskImportResult> {
  if (running) throw new Error('正在导入会话，请稍候');
  if (!Array.isArray(params) || params.some(item => !item || typeof item.id !== 'string' || typeof item.revision !== 'string')) throw new Error('请选择要导入的会话');
  const controller = new AbortController();
  running = controller;
  const signal = anySignal([controller.signal, closing.signal]);
  const result: CodexTaskImportResult = { items: [] };
  try {
    const home = homeForTasks();
    // Finish an existing automatic upgrade before appending; never swap a live home for manual import.
    await resolveAgentHomeRoot('codex');
    signal.throwIfAborted();
    const scan = await readCodexTasks(home.userConfigRoot, signal);
    if (scan.status !== 'ready') throw new Error('暂时无法读取 ChatGPT 的本机会话索引');
    const available = new Map(scan.rows.map(row => [row.id, row]));
    const selected: CodexTaskSourceRow[] = [];
    for (const request of new Map(params.map(item => [item.id, item])).values()) {
      const row = available.get(request.id);
      if (!row) { result.items.push({ id: request.id, status: 'missing' }); continue; }
      if (row.revision !== request.revision) { result.items.push({ id: request.id, status: 'changed' }); continue; }
      const [existing] = await db.select({ sessionId: sessions.id }).from(sessions)
        .where(and(eq(sessions.provider, 'codex'), eq(sessions.providerSessionId, row.id))).limit(1);
      if (existing) result.items.push({ id: row.id, status: 'existing', ...existing });
      else selected.push(row);
    }
    if (!selected.length) return result;
    await ensureAgentHome(home);
    const ids = new Set(selected.map(row => row.id));
    const ownership = new Map(selected.map(row => [row.relativePath, { id: row.id, primary: true }]));
    for (const row of selected) for (const file of row.files) {
      if (!ownership.has(file.relativePath)) ownership.set(file.relativePath, { id: row.id, primary: false });
    }
    // Use the same planner with the source-validated complete lineage as each session's bundle.
    const selectedHome = { ...home, upgradeHistory: [...ownership.keys()], historySession: (path: string) => ownership.get(path) ?? null };
    const plan = await planAgentHomeHistory(selectedHome, Number.MAX_SAFE_INTEGER, { sessionIds: ids, includeShared: false });
    if (plan.issues.length || [...ownership.keys()].some(path => !plan.paths.includes(path))) throw new Error('会话原文发生变化，请重新扫描后导入');
    const targets = selected;
    preparation = { phase: 'copying', startedAt: Date.now() };
    await appendAgentHomeHistory(selectedHome, plan.paths, {
      signal, validate: async root => {
        await verifyCodexTaskFiles(root, selected, signal);
        const latest = await readCodexTasks(home.userConfigRoot, signal);
        const revisions = new Map(latest.rows.map(row => [row.id, row.revision]));
        if (latest.status !== 'ready' || selected.some(row => revisions.get(row.id) !== row.revision)) {
          throw new Error('会话在复制期间发生变化，请重新扫描后导入');
        }
      },
    });
    // Existing managed continuations are deliberately preserved, then validated before being bound.
    await verifyCodexTaskFiles(home.configRoot, targets, signal);
    for (const row of targets) await ledger.setOrThrow(row.id, { revision: row.revision, path: row.relativePath, state: 'copied' });
    preparation = { phase: 'history', startedAt: Date.now() };
    await prepareManagedCodexHistory(home, signal, undefined, targets.map(row => ({ id: row.id, path: join(home.configRoot, row.relativePath) })));
    for (const row of targets) await ledger.setOrThrow(row.id, { revision: row.revision, path: row.relativePath, state: 'prepared' });
    preparation = { phase: 'binding', startedAt: Date.now() };
    for (const row of targets) {
      signal.throwIfAborted();
      try {
        const binding = await bindLocalSession({ engine: 'codex', providerSessionId: row.id,
          filePath: join(home.configRoot, row.relativePath), title: row.title, cwd: row.cwd, sessionView: 'general' },
        { providerSessionId: row.id, title: row.title, cwd: row.cwd });
        await ledger.setOrThrow(row.id, { revision: row.revision, path: row.relativePath, state: 'bound', sessionId: binding.sessionId });
        result.items.push({ id: row.id, status: binding.alreadyImported ? 'existing' : 'imported', sessionId: binding.sessionId });
      } catch {
        signal.throwIfAborted();
        result.items.push({ id: row.id, status: 'failed', message: '这条会话尚未导入，请重试' });
      }
    }
    return result;
  } finally { running = undefined; preparation = null; }
}
