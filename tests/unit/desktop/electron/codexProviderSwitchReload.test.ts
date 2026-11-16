// @@@vitest-environment node
/**
 * Switching a Codex task between the user's own route (provider `openai`) and a Gugu platform model
 * (provider `gugu_platform`) must leave a task that still takes the next turn.
 *
 * Codex binds a thread to the provider it was created with and refuses to resume it under another one
 * (codex-rs app-server `config_manager.rs` `load_for_resume`: "Cannot change this thread's model provider
 * from `<saved>` to `<requested>` on resume."). A reopened adapter runs on the new route's provider, so
 * resuming the old thread fails on every retry. The host's cross-route reload asks the provider's
 * descriptor (`credentialLifecycle.acp.sourceChangeSession`) whether to resume the native session or
 * open a new one; this drives the real bridge with that answer against an app-server that enforces
 * Codex's rule, on both directions of the switch.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSessionpageCredentialLifecycle } from '@gugu/session-plugins/agents';
import { awaitFact } from '../../../support/awaitFact';

const ADAPTER = resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs');
// Threads persist in FAKE_STORE across adapter processes, each with the provider it was created on.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const store = process.env.FAKE_STORE;
const provider = process.env.FAKE_PROVIDER;
const load = () => fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
const save = (threads) => fs.writeFileSync(store, JSON.stringify(threads));
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const opened = (id) => ({ thread: { id, historyMode: 'paginated', ephemeral: false }, model: 'm', reasoningEffort: 'medium', modelProvider: provider });
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const threads = load();
  if (m.method === 'initialize') return out({ id: m.id, result: { userAgent: 'fixture' } });
  if (m.method === 'thread/start') {
    if (m.params.ephemeral) return out({ id: m.id, result: { thread: { id: 'probe', ephemeral: true }, modelProvider: provider } });
    const id = 'thread-' + (Object.keys(threads).length + 1);
    threads[id] = { provider, inputs: [] };
    save(threads);
    return out({ id: m.id, result: opened(id) });
  }
  if (m.method === 'thread/resume') {
    const saved = threads[m.params.threadId]?.provider;
    const requested = m.params.modelProvider ?? saved;
    if (saved !== requested) {
      return out({ id: m.id, error: { code: -32600, message: 'failed to load configuration: Cannot change this thread\\'s model provider from \\'' + saved + '\\' to \\'' + requested + '\\' on resume.' } });
    }
    return out({ id: m.id, result: opened(m.params.threadId) });
  }
  if (m.method === 'turn/start') {
    threads[m.params.threadId].inputs.push(m.params.input.map((part) => part.text).join(''));
    save(threads);
    const turn = { id: 'turn-' + m.id, status: 'completed' };
    out({ method: 'item/started', params: { threadId: m.params.threadId, item: { type: 'userMessage', id: 'user-' + m.id, clientId: m.params.clientUserMessageId, content: m.params.input } } });
    out({ id: m.id, result: { turn } });
    return out({ method: 'turn/completed', params: { threadId: m.params.threadId, turn } });
  }
  if (m.method === 'model/list') return out({ id: m.id, result: { data: [{ id: 'm', model: 'm', displayName: 'M', isDefault: true, supportedReasoningEfforts: [] }] } });
  out({ id: m.id, result: { data: [] } });
});
`;

let dir = '';
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const ended = new Promise((done) => child.once('exit', done));
    child.kill('SIGTERM');
    await ended;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

type Reply = { result?: Record<string, unknown>; error?: { message?: string } };

/** One adapter process = one route: the provider its app-server would start a thread on. */
function adapterOn(provider: string) {
  const fake = join(dir, 'fake-codex.cjs');
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: fake, FAKE_PROVIDER: provider, FAKE_STORE: join(dir, 'threads.json'),
      GUGU_HOME: join(dir, 'gugu-home'), GUGU_USER_DATA_DIR: join(dir, 'gugu-userdata') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const replies = new Map<number, Reply>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) replies.set(message.id, message);
  });
  let id = 0;
  return async (method: string, params: unknown): Promise<Reply> => {
    const requestId = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    return awaitFact(method, () => replies.get(requestId), { producer: child });
  };
}

async function switchRoute(from: string, to: string) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'gugu-codex-provider-switch-')));
  writeFileSync(join(dir, 'fake-codex.cjs'), FAKE_CODEX);
  chmodSync(join(dir, 'fake-codex.cjs'), 0o755);
  const open = { cwd: dir, mcpServers: [] };

  const before = adapterOn(from);
  await before('initialize', { protocolVersion: 2, capabilities: {} });
  const created = await before('session/new', open);
  const original = String(created.result?.sessionId);
  expect(await before('session/prompt', { sessionId: original, prompt: [{ type: 'text', text: 'before the switch' }] }))
    .toMatchObject({ result: { messageId: expect.any(String) } });

  // The host reloads the task on the other route and asks the descriptor what happens to the native session.
  const answer = resolveSessionpageCredentialLifecycle('codex', 'acp')?.sourceChangeSession;
  const after = adapterOn(to);
  await after('initialize', { protocolVersion: 2, capabilities: {} });
  const reopened = answer === 'replace'
    ? await after('session/new', open)
    : await after('session/resume', { ...open, sessionId: original, replayFrom: { type: 'start' } });
  expect(reopened.error?.message).toBeUndefined();
  const current = answer === 'replace' ? String(reopened.result?.sessionId) : original;
  expect(await after('session/prompt', { sessionId: current, prompt: [{ type: 'text', text: 'after the switch' }] }))
    .toMatchObject({ result: { messageId: expect.any(String) } });

  const threads = JSON.parse(readFileSync(join(dir, 'threads.json'), 'utf8')) as Record<string, { provider: string; inputs: string[] }>;
  // The earlier turn is still there, on the thread of the route it ran on; the next one ran on the new route.
  expect(threads[original]).toEqual({ provider: from, inputs: ['before the switch'] });
  expect(threads[current]).toEqual({ provider: to, inputs: ['after the switch'] });
}

describe('Codex task switching between the own route and a platform model', () => {
  it('own (openai) -> platform (gugu_platform): the next turn starts and the earlier turn is kept', async () => {
    await switchRoute('openai', 'gugu_platform');
  });

  it('platform (gugu_platform) -> own (openai): the next turn starts and the earlier turn is kept', async () => {
    await switchRoute('gugu_platform', 'openai');
  });
});
