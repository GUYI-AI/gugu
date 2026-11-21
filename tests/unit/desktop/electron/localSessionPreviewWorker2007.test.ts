import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createLocalSessionPreviewClient } from '../../../../apps/desktop/electron/sessionpage/local-session-preview-client';
import type { LocalPreviewRequest } from '../../../../apps/desktop/electron/sessionpage/local-session-preview';

let root: string, bundle: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'preview-thread2007-')); bundle = join(root, 'preview.mjs');
  await build({ entryPoints: ['apps/desktop/electron/sessionpage/local-session-preview-worker.ts'], outfile: bundle,
    bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent' });
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const request = (filePath: string): LocalPreviewRequest => ({ filePath, engine: 'claude-code',
  scanOptions: { nativeHomes: { 'claude-code': [join(root, 'native')], codex: [join(root, 'native')] } } });

it('executes the bundled reader on its thread, keeps a main-thread heartbeat and returns no full-history object', async () => {
  const directory = join(root, 'native', 'projects'); await mkdir(directory, { recursive: true });
  const filePath = join(directory, 'huge.jsonl'), file = await open(filePath, 'w');
  const record = (text: string) => JSON.stringify({ type: 'user', sessionId: 'real-id', cwd: '/work', message: { role: 'user', content: text } });
  const size = 596_177_689, tail = '\n' + record('最后一条') + '\n';
  try { await file.write(record('第一条') + '\n', 0, 'utf8'); await file.truncate(size); await file.write(tail, size - Buffer.byteLength(tail), 'utf8'); }
  finally { await file.close(); }
  const client = createLocalSessionPreviewClient(() => new Worker(bundle, { execArgv: [] }));
  let ticks = 0; const heartbeat = setInterval(() => ticks++, 1);
  try {
    const result = await client.read(request(filePath), new AbortController().signal);
    expect(ticks).toBeGreaterThan(0);
    expect(result).toMatchObject({ providerSessionId: 'real-id', turnCount: null, incomplete: true,
      head: [{ content: '第一条' }], tail: [{ content: '最后一条' }], io: { sourceBytes: 128 * 1024 } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(32 * 1024);
    expect(result).not.toHaveProperty('turns');
  } finally { clearInterval(heartbeat); await client.dispose(); }
});

class HeldWorker extends EventEmitter {
  postMessage = vi.fn(); unref = vi.fn(); terminate = vi.fn(async () => 0);
}

it('fails pending requests on disposal, aborts without waiting for a history scan, and starts no thread after disposal', async () => {
  const worker = new HeldWorker(), spawn = vi.fn(() => worker as unknown as Worker);
  const client = createLocalSessionPreviewClient(spawn), controller = new AbortController();
  const reading = client.read(request('/unused'), controller.signal);
  const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await rejected;
  expect(worker.postMessage.mock.calls[1]![0]).toMatchObject({ cancel: true });
  const pending = client.read(request('/unused'), new AbortController().signal);
  const stopped = expect(pending).rejects.toThrow('shutting down');
  await client.dispose(); await stopped;
  expect(worker.terminate).toHaveBeenCalledOnce();
  await expect(client.read(request('/unused'), new AbortController().signal)).rejects.toThrow('shutting down');
  expect(spawn).toHaveBeenCalledOnce();
});

it('fails all callers and terminates its own thread at the deadline', async () => {
  vi.useFakeTimers();
  const worker = new HeldWorker(), client = createLocalSessionPreviewClient(() => worker as unknown as Worker);
  try {
    const reading = client.read(request('/unused'), new AbortController().signal);
    const rejected = expect(reading).rejects.toThrow('deadline exceeded');
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  } finally { await client.dispose(); vi.useRealTimers(); }
});
