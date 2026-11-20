import { importItemMetadata } from './metadata';
import { homedir } from 'node:os';
import { anySignal } from '@gugu/core/shared/anySignal';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { resolveAgentHome } from '@gugu/session-core/agents/plugins/helpers';
import { appScope } from '@main/app/app-scope';
import { resolveAgentHomeRoot } from '@main/core/agents/agent-home';
import { loginShellEnv } from '@main/utils/userEnv';
import {
  isEnvironmentImportCategory,
  type EnvironmentImportCategory,
  type EnvironmentImportRequest, type EnvironmentImportScan,
} from '@shared/core/session-import/environment-import';
import { scanCodexProjects, importCodexProjects } from './projects';
import { scanCodexSkills, importCodexSkills } from './skills';
import { scanCodexConnectors, importCodexConnectors } from './connectors';
import { scanCodexMemories, importCodexMemories } from './memories';

const closing = new AbortController();
appScope.add(() => closing.abort());
let active: { id: string; controller: AbortController } | undefined;

function homeForImport() {
  const bundle = pluginRegistry.get('codex')?.capabilities.sessionBundle;
  if (!bundle?.configRoot) throw new Error('本机未提供 ChatGPT 导入');
  const home = resolveAgentHome({ providerId: 'codex', injectionMode: bundle.injectionMode,
    configRoot: bundle.configRoot, guguHome: process.env.GUGU_HOME ?? '', osHomeDir: homedir(),
    sourceEnv: { ...process.env, ...loginShellEnv() } });
  if (!home) throw new Error('本机未提供 ChatGPT 导入');
  return home;
}

function category(value: unknown): asserts value is Exclude<EnvironmentImportCategory, 'tasks'> {
  if (!isEnvironmentImportCategory(value) || value === 'tasks') throw new Error('请选择导入类别');
}

export async function scanEnvironmentImport(value: Exclude<EnvironmentImportCategory, 'tasks'>, signal: AbortSignal = closing.signal): Promise<EnvironmentImportScan> {
  category(value);
  const home = homeForImport();
  // A scan must not wait for automatic migration or initialize an engine.
  const scan = value === 'projects' ? await scanCodexProjects({ sourceRoot: home.userConfigRoot, signal })
    : value === 'skills' ? await scanCodexSkills({ home, signal })
    : value === 'connectors' ? await scanCodexConnectors({ home, signal })
    : await scanCodexMemories({ home, signal });
  if (!Number.isSafeInteger(scan.count) || scan.count < 0 || ('status' in scan && ['unreadable', 'invalid', 'source-changed', 'sensitive', 'unavailable'].includes(String(scan.status)))) {
    throw new Error('暂时无法读取这类本机数据，请刷新后重试');
  }
  return { count: scan.count, items: scan.items.map(item => importItemMetadata(item)) };
}

export function cancelEnvironmentImport(id: string): void {
  if (active?.id === id) active.controller.abort();
}

export async function importEnvironmentCategory(request: EnvironmentImportRequest): Promise<{ items: EnvironmentImportItem[] }> {
  category(request?.category);
  if (typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128
    || !Array.isArray(request.selection) || request.selection.length > 10_000
    || request.selection.some(item => !item || typeof item.localSourceId !== 'string'
      || item.localSourceId.length > 512 || typeof item.fingerprint !== 'string' || item.fingerprint.length > 512)) {
    throw new Error('请选择要导入的内容');
  }
  if (active) throw new Error('正在导入，请稍候');
  const controller = new AbortController();
  active = { id: request.requestId, controller };
  const signal = anySignal([controller.signal, closing.signal]);
  try {
    const home = homeForImport();
    // Imports append to the established home; they never race the upgrade's swap.
    await resolveAgentHomeRoot('codex');
    signal.throwIfAborted();
    const before = await scanEnvironmentImport(request.category, signal);
    const names = new Map(before.items.map(item => [item.localSourceId, item.name]));
    const options = { home, signal, selection: request.selection };
    const result = request.category === 'projects' ? { items: await importCodexProjects(
      request.selection.map(item => ({ localSourceId: item.localSourceId, sourceFingerprint: item.fingerprint })),
      { sourceRoot: home.userConfigRoot, signal }) }
      : request.category === 'skills' ? await importCodexSkills(options)
      : request.category === 'connectors' ? await importCodexConnectors(options)
      : await importCodexMemories(options);
    return { items: result.items.map(item => importItemMetadata(item, names)) };
  } finally { active = undefined; }
}
