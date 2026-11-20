import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { resolveAgentHome, planAgentHomeHistory, appendAgentHomeHistory } from '@gugu/session-core/agents/plugins/helpers';
import { codexSessionBundleDescriptor as bundle } from '../../../../../../../packages/session-plugins/src/agents/impl/codex/session-bundle';
import { scanCodexTasks, verifyCodexTaskFiles } from './codex-task-source';

const root = process.env.GUGU_NATIVE_IMPORT_ROOT ?? '';
const cli = process.env.GUGU_NATIVE_IMPORT_CLI ?? '';
const enabled = Boolean(root && cli);
if (enabled && (!root.startsWith('/Users/mac1/chatgpt-import-3216/native-') || !cli.startsWith('/Users/mac1/'))) throw new Error('Explicit isolated native acceptance inputs required');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const children: ChildProcess[] = [];
const observeBeforeSignal = () => spawnSync('/usr/bin/pgrep', ['-af', cli], { encoding: 'utf8' });
if (enabled) process.once('SIGTERM', () => {
  observeBeforeSignal();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});

async function client(home: string, port: number, caseRoot: string) {
  const env = { PATH: process.env.PATH!, HOME: join(caseRoot, 'os-home'), GUGU_HOME: join(caseRoot, 'gugu'),
    GUGU_USER_DATA_DIR: join(caseRoot, 'profile'), CODEX_HOME: home, LANG: 'en_US.UTF-8',
    RAYON_NUM_THREADS: '1', TOKIO_WORKER_THREADS: '1', UV_THREADPOOL_SIZE: '1', OMP_NUM_THREADS: '1',
    DISABLE_AUTOUPDATER: '1', OPENAI_API_KEY: 'sk-synthetic-local-only', NO_PROXY: '127.0.0.1,localhost' };
  for (const path of [home, env.HOME, env.GUGU_HOME, env.GUGU_USER_DATA_DIR]) await mkdir(path, { recursive: true });
  await writeFile(join(home, 'config.toml'), `model = "gpt-6.2-sol"\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:${port}/v1"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[features]\napi_key_model_discovery = false\nresponses_websockets = false\nresponses_websockets_v2 = false\n`);
  const child = spawn(cli, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  const birth = spawnSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
  await writeFile(join(caseRoot, 'native-child.json'), JSON.stringify({ pid: child.pid, birth, cli, CODEX_HOME: home }));
  let buffer = '', stderr = '', id = 0;
  const notifications: any[] = [];
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
  child.stdout!.on('data', chunk => {
    buffer += String(chunk);
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message: any; try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'turn/completed') notifications.push(message.params);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
    }
  });
  child.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
  child.on('close', code => { for (const waiter of pending.values()) waiter.reject(new Error(`Native exited ${code}: ${stderr}`)); });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const key = ++id; pending.set(key, { resolve, reject }); child.stdin!.write(JSON.stringify({ id: key, method, params }) + '\n');
  });
  const init = performance.now();
  try {
    await request('initialize', { clientInfo: { name: 'gugu-native-import-acceptance', title: 'Gugu native import acceptance', version: '0' }, capabilities: { experimentalApi: true } });
    child.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n');
    await request('config/read', { includeLayers: false });
  } catch (error) { await stop(child); throw error; }
  return { child, request, notifications, initializeMs: performance.now() - init, env };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin!.end();
  await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 2000))]);
  if (child.exitCode === null && child.signalCode === null) {
    observeBeforeSignal();
    child.kill('SIGTERM'); await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 2000))]);
  }
  if (child.exitCode === null && child.signalCode === null) throw new Error('Owned native child did not exit; preserve its root');
}

// These real-engine cases are opt-in. A green default CI does not sign native continuation.
it.runIf(enabled).each(['sessions', 'archived_sessions', 'missing'])("native resume carries complete ancestry: %s", async location => {
  const caseRoot = join(root, location); await mkdir(caseRoot, { recursive: true });
  const home = resolveAgentHome({ providerId: 'codex', injectionMode: bundle.injectionMode, configRoot: bundle.configRoot,
    guguHome: join(caseRoot, 'gugu'), osHomeDir: join(caseRoot, 'source-user'), sourceEnv: {} })!;
  const taskId = randomUUID(), parentId = randomUUID(), stamp = new Date().toISOString();
  const secret = 'ANCESTOR_CONTEXT_' + randomUUID();
  const meta = (id: string, base: unknown) => ({ id, session_id: id, timestamp: stamp, cwd: '/private/tmp', originator: 'codex_cli_rs',
    cli_version: '0.160.0', source: 'cli', thread_source: 'user', model_provider: 'openai', history_mode: 'paginated',
    history_base: base, base_instructions: { text: 'Follow the person\'s instructions.' } });
  const line = (ordinal: number, type: string, payload: unknown) => JSON.stringify({ timestamp: stamp, ordinal, type, payload }) + '\n';
  const parent = line(0, 'session_meta', meta(parentId, null))
    + line(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Remember ' + secret }] })
    + line(2, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will remember it.' }] });
  const primary = `sessions/2026/11/19/rollout-2026-11-19T00-00-00-${taskId}.jsonl`;
  const ancestor = `${location === 'missing' ? 'sessions' : location}/rollout-2026-11-19T00-00-00-${parentId}.jsonl`;
  const task = line(3, 'session_meta', meta(taskId, { thread_id: parentId, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(parent) }))
    + line(4, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue this task.' }] });
  for (const [path, content] of [[primary, task], [ancestor, parent]]) {
    if (location === 'missing' && path === ancestor) continue;
    await mkdir(dirname(join(home.userConfigRoot, path)), { recursive: true }); await writeFile(join(home.userConfigRoot, path), content);
  }
  const sourceDb = new Database(join(home.userConfigRoot, 'state_5.sqlite'));
  sourceDb.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, thread_source TEXT, archived INTEGER)');
  sourceDb.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(taskId, 'Native lineage acceptance', '/private/tmp', join(home.userConfigRoot, primary), 1, 'user', 0); sourceDb.close();
  const scan = await scanCodexTasks(home.userConfigRoot);
  if (location !== 'missing') {
    expect(scan.rows).toHaveLength(1);
    const row = scan.rows[0]; expect(row.files).toHaveLength(2);
    const map = new Map(row.files.map(file => [file.relativePath, { id: row.id, primary: file.relativePath === row.relativePath }]));
    const selectedHome = { ...home, upgradeHistory: [...map.keys()], historySession: (path: string) => map.get(path) ?? null };
    const plan = await planAgentHomeHistory(selectedHome, Number.MAX_SAFE_INTEGER, { sessionIds: new Set([row.id]), includeShared: false });
    await appendAgentHomeHistory(selectedHome, plan.paths, { signal: new AbortController().signal, validate: root => verifyCodexTaskFiles(root, [row]) });
  } else {
    expect(scan.rows).toHaveLength(0); expect(scan.blocked).toEqual([{ id: taskId, reason: 'missing-history' }]);
    // Negative native control deliberately installs the incomplete synthetic fixture; product import refused it above.
    await mkdir(dirname(join(home.configRoot, primary)), { recursive: true });
    await writeFile(join(home.configRoot, primary), task);
  }
  const sourceHash = hash(await readFile(join(home.userConfigRoot, primary)));
  let observed = false, requests = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/responses')) { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    requests++; observed = body.includes(secret);
    const output = [{ id: 'msg_' + randomUUID(), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: observed ? 'ANCESTRY_OK' : 'ANCESTRY_MISSING', annotations: [], logprobs: [] }] }];
    const response = { id: 'resp_' + randomUUID(), object: 'response', status: 'completed', model: 'gpt-6.2-sol', output, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }) + '\n\n');
    res.write('event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: output[0] }) + '\n\n');
    res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  let native: Awaited<ReturnType<typeof client>> | undefined;
  try {
    native = await client(home.configRoot, port, caseRoot);
    const start = performance.now();
    if (location === 'missing') {
      await expect(native.request('thread/resume', { threadId: taskId, excludeTurns: true }))
        .rejects.toThrow(/invalid paginated history lineage.*missing source rollout/);
      expect(requests).toBe(0);
      await writeFile(join(caseRoot, 'result.json'), JSON.stringify({ case: location, rejectedBeforeImport: true, nativeResumeRejected: true,
        noTaskCreated: true, loopbackResponses: 0, upstreamCalls: 0 }));
      return;
    }
    const resumed = await native.request('thread/resume', { threadId: taskId, excludeTurns: true });
    expect(resumed.thread.id).toBe(taskId); expect(resumed.thread.path.startsWith(home.configRoot + '/')).toBe(true);
    await native.request('turn/start', { threadId: taskId, input: [{ type: 'text', text: 'Recall the inherited context, reply briefly.' }] });
    for (let i = 0; i < 150 && !native.notifications.some(event => event.threadId === taskId); i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(requests).toBe(1); expect(observed).toBe(true);
    expect(native.notifications.some(event => event.threadId === taskId && event.turn?.status === 'completed')).toBe(true);
    expect(hash(await readFile(join(home.userConfigRoot, primary)))).toBe(sourceHash);
    await writeFile(join(caseRoot, 'result.json'), JSON.stringify({ case: location, nativeResume: true, resumeMs: performance.now() - start,
      ancestorReachedActualModelRequest: observed, nativeTurnCompleted: true, loopbackResponses: requests, upstreamCalls: 0, sourceUnchanged: true, environment: native.env }));
  } finally { if (native) await stop(native.child); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 90000);
