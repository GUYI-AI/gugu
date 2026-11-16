// @@@vitest-environment node
/**
 * Switching a Codex task between the user's own route (provider `openai`) and a Gugu platform model
 * (provider `gugu_platform`) must leave a task that takes the next turn with the conversation so far.
 *
 * Codex binds a thread to the provider it was created with: since 0.166 app-server refuses `thread/resume` under
 * another one, in both directions, whatever `modelProvider` the request carries. `thread/fork` run by the new
 * route's app-server does carry the thread's history onto that process's provider. The host's cross-route reload asks
 * the provider's descriptor (`credentialLifecycle.acp.sourceChangeSession`) what to do with the native session; this
 * drives the real bridge with that answer, the way the runtime issues it, against an app-server that keeps Codex's
 * rules (threads persist across adapter processes; a thread that never took a turn has no rollout to fork).
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
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const store = process.env.FAKE_STORE;
const provider = process.env.FAKE_PROVIDER;
const load = () => fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
const save = (threads) => fs.writeFileSync(store, JSON.stringify(threads));
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const opened = (id) => ({ thread: { id, historyMode: 'paginated', ephemeral: false }, model: 'm', reasoningEffort: 'medium', modelProvider: provider });
const noRollout = (id) => ({ code: -32600, message: 'no rollout found for thread id ' + id });
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const threads = load();
  if (m.method === 'initialize') return out({ id: m.id, result: { userAgent: 'fixture' } });
  if (m.method === 'thread/start') {
    if (m.params.ephemeral) return out({ id: m.id, result: { thread: { id: 'probe', ephemeral: true }, modelProvider: provider } });
    const id = 'thread-' + (Object.keys(threads).length + 1);
    threads[id] = { provider, inputs: [], injected: [], rollout: false };
    save(threads);
    return out({ id: m.id, result: opened(id) });
  }
  if (m.method === 'thread/resume') {
    const saved = threads[m.params.threadId];
    if (!saved?.rollout) return out({ id: m.id, error: noRollout(m.params.threadId) });
    // codex >= 0.166: the configured provider must be the thread's; a modelProvider override does not change that.
    if (saved.provider !== provider) {
      return out({ id: m.id, error: { code: -32600, message: 'failed to load configuration: Cannot change this thread\\'s model provider from \\'' + saved.provider + '\\' to \\'' + provider + '\\' on resume.' } });
    }
    return out({ id: m.id, result: opened(m.params.threadId) });
  }
  if (m.method === 'thread/fork') {
    const source = threads[m.params.threadId];
    if (!source?.rollout) return out({ id: m.id, error: noRollout(m.params.threadId) });
    const id = 'thread-' + (Object.keys(threads).length + 1);
    threads[id] = { provider, inputs: [...source.inputs], injected: [], rollout: true, forkedFrom: m.params.threadId, ephemeral: m.params.ephemeral };
    save(threads);
    return out({ id: m.id, result: opened(id) });
  }
  if (m.method === 'thread/inject_items') {
    threads[m.params.threadId].injected.push(...m.params.items);
    save(threads);
    return out({ id: m.id, result: {} });
  }
  if (m.method === 'turn/start') {
    const thread = threads[m.params.threadId];
    thread.inputs.push(m.params.input.map((part) => part.text).join(''));
    // The user message reaches the rollout even when the model call is refused (codex 0.169).
    thread.rollout = true;
    save(threads);
    const failed = process.env.FAKE_REFUSE_TURNS === '1';
    const turn = failed
      ? { id: 'turn-' + m.id, status: 'failed', error: { message: 'unexpected status 401 Unauthorized', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } } }
      : { id: 'turn-' + m.id, status: 'completed' };
    out({ method: 'item/started', params: { threadId: m.params.threadId, item: { type: 'userMessage', id: 'user-' + m.id, clientId: m.params.clientUserMessageId, content: m.params.input } } });
    out({ id: m.id, result: { turn: { id: turn.id, status: 'inProgress' } } });
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
type Thread = { provider: string; inputs: string[]; injected: unknown[]; forkedFrom?: string; ephemeral?: boolean };

function setUp() {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'gugu-codex-provider-switch-')));
  writeFileSync(join(dir, 'fake-codex.cjs'), FAKE_CODEX);
  chmodSync(join(dir, 'fake-codex.cjs'), 0o755);
}

const open = () => ({ cwd: dir, mcpServers: [] });
const threads = () => JSON.parse(readFileSync(join(dir, 'threads.json'), 'utf8')) as Record<string, Thread>;

/** One adapter process = one route: the provider its app-server starts threads on. */
async function adapterOn(provider: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [ADAPTER], {
    cwd: dir,
    env: { ...process.env, GUGU_CODEX_BIN: join(dir, 'fake-codex.cjs'), FAKE_PROVIDER: provider, FAKE_STORE: join(dir, 'threads.json'),
      GUGU_HOME: join(dir, 'gugu-home'), GUGU_USER_DATA_DIR: join(dir, 'gugu-userdata'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const replies = new Map<number, Reply>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) replies.set(message.id, message);
  });
  let id = 0;
  const call = async (method: string, params: unknown): Promise<Reply> => {
    const requestId = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    return awaitFact(method, () => replies.get(requestId), { producer: child });
  };
  await call('initialize', { protocolVersion: 2, capabilities: {} });
  return call;
}

const prompt = (text: string) => [{ type: 'text', text }];

/**
 * The reload's reopen as the runtime issues it for the descriptor's answer (session-manager: a route-switch fork is a
 * persistent `session/fork` marked `forkKeepsAgent`, then the forked session opens like a resume, without replay).
 */
async function reopen(call: Awaited<ReturnType<typeof adapterOn>>, original: string, sourceChanged: boolean) {
  const answer = sourceChanged ? resolveSessionpageCredentialLifecycle('codex', 'acp')?.sourceChangeSession : 'preserve';
  if (answer === 'replace') return call('session/new', open());
  if (answer === 'fork') {
    const forked = await call('session/fork', {
      ...open(), sessionId: original, _meta: { gugu: { ephemeralFork: false, forkKeepsAgent: true } },
    });
    if (forked.error) return forked;
    const sessionId = String(forked.result?.sessionId);
    const resumed = await call('session/resume', { ...open(), sessionId });
    return resumed.error ? resumed : { result: { ...resumed.result, sessionId } };
  }
  const resumed = await call('session/resume', { ...open(), sessionId: original });
  return resumed.error ? resumed : { result: { ...resumed.result, sessionId: original } };
}

async function switchRoute(from: string, to: string, firstTurn: Record<string, string> = {}) {
  setUp();
  const before = await adapterOn(from, firstTurn);
  const original = String((await before('session/new', open())).result?.sessionId);
  await before('session/prompt', { sessionId: original, prompt: prompt('before the switch') });

  const after = await adapterOn(to);
  const reopened = await reopen(after, original, from !== to);
  expect(reopened.error?.message).toBeUndefined();
  const current = String(reopened.result?.sessionId);
  expect(await after('session/prompt', { sessionId: current, prompt: prompt('after the switch') }))
    .toMatchObject({ result: { messageId: expect.any(String) } });
  return { original, current, threads: threads() };
}

describe('Codex task switching between the own route and a platform model', () => {
  it.each([
    ['own (openai) -> platform (gugu_platform)', 'openai', 'gugu_platform'],
    ['platform (gugu_platform) -> own (openai)', 'gugu_platform', 'openai'],
  ])('%s: the next turn runs on the new route with the conversation so far', async (_label, from, to) => {
    const { original, current, threads } = await switchRoute(from, to);
    expect(current).not.toBe(original);
    // The new route's thread carries the earlier turn, as the same agent: no "you are a forked agent" handoff.
    expect(threads[current]).toMatchObject({ provider: to, inputs: ['before the switch', 'after the switch'], injected: [], ephemeral: false });
    expect(threads[current].forkedFrom).toBe(original);
    // The old thread is left as it was on its own route.
    expect(threads[original]).toMatchObject({ provider: from, inputs: ['before the switch'] });
  });

  it('a model switch on the same route resumes the original thread', async () => {
    const { original, current, threads } = await switchRoute('gugu_platform', 'gugu_platform');
    expect(current).toBe(original);
    expect(threads[original]).toMatchObject({ provider: 'gugu_platform', inputs: ['before the switch', 'after the switch'] });
    expect(Object.keys(threads)).toEqual([original]);
  });

  it('a thread whose first turn was refused (401) switches over and keeps that message', async () => {
    const { original, current, threads } = await switchRoute('gugu_platform', 'openai', { FAKE_REFUSE_TURNS: '1' });
    expect(threads[current]).toMatchObject({ provider: 'openai', inputs: ['before the switch', 'after the switch'], injected: [] });
    expect(threads[current].forkedFrom).toBe(original);
  });
});
