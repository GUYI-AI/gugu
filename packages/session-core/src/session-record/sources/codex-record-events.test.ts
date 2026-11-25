import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitFact } from '../../../../../tests/support/awaitFact';
import { CodexRecordDeadline, waitForCodexRecord, type RecordDirectoryWatch } from './codex-record-events';
import { SessionRecordNotFoundError } from './shared';
import { createCodexJsonlSource } from './codex-jsonl';
import { TailReader } from './tail-reader';

const THREAD = '01a20e21-ffaf-7ff0-ac0b-9cda461fa5b3';
const meta = JSON.stringify({ type: 'session_meta', payload: { id: THREAD } }) + '\n';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); while (cleanups.length) await cleanups.pop()!(); });
async function setup(missing = false) {
  const temp = await mkdtemp(join(tmpdir(), 'codex-record-events-'));
  cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const root = missing ? join(temp, 'agent', 'sessions') : temp;
  const file = join(root, '2026', '11', '24', `rollout-${THREAD}.jsonl`);
  const locator = { harness: 'codex' as const, providerSessionId: THREAD, roots: [root] };
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const handles: Array<{ path: string; changed: () => void; failed: (error: unknown) => void; disposed: boolean }> = [];
  const watch: RecordDirectoryWatch = (path, changed, failed) => {
    const item = { path, changed, failed, disposed: false };
    handles.push(item);
    return { ready: async () => {}, dispose: async () => { item.disposed = true; } };
  };
  let exists = false;
  const locate = vi.fn(async () => { if (!exists) throw new SessionRecordNotFoundError('not written', [root]); return file; });
  const create = async (data = meta) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, data); exists = true; };
  const fire = () => { for (const item of [...handles]) if (!item.disposed) item.changed(); };
  return { root, file, locator, abort, handles, watch, locate, create, fire };
}

describe('Codex record readiness barrier', () => {
  it('finds a file created before subscription only after every watch reports ready', async () => {
    const s = await setup();
    await s.create();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const watch: RecordDirectoryWatch = () => ({ ready: () => ready, dispose: async () => {} });
    const opening = waitForCodexRecord(s.locator, s.locate, s.abort.signal, watch);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(s.locate).not.toHaveBeenCalled();
    release();
    await opening;
    expect(s.locate).toHaveBeenCalledOnce();
  });

  it('follows missing directories from an ancestor and reads a file created after subscription', async () => {
    const s = await setup(true);
    let waiting!: () => void;
    const absent = new Promise<void>(resolve => { waiting = resolve; });
    const opening = waitForCodexRecord(s.locator, s.locate, s.abort.signal, s.watch, waiting);
    await absent;
    expect(s.handles.some(h => h.path === dirname(dirname(s.root)))).toBe(true);
    await s.create();
    s.fire();
    await opening;
    expect(s.locate.mock.calls.length).toBeGreaterThan(1);
    expect(s.handles.every(h => h.disposed)).toBe(true);
  });

  it('waits for a complete first write rather than treating an empty or partial file as ready', async () => {
    const s = await setup();
    await s.create('');
    let count = 0;
    const opening = waitForCodexRecord(s.locator, s.locate, s.abort.signal, s.watch, () => { count++; });
    await awaitFact('empty file observed', () => count >= 1 || undefined);
    await appendFile(s.file, meta.slice(0, -1));
    s.fire();
    await awaitFact('partial line observed', () => count >= 2 || undefined);
    await appendFile(s.file, '\n');
    s.fire();
    await opening;
    expect(s.handles.every(h => h.disposed)).toBe(true);
  });

  it('reports a watch error after ready and disposes all subscriptions', async () => {
    const s = await setup();
    let waiting!: () => void;
    const absent = new Promise<void>(resolve => { waiting = resolve; });
    const opening = waitForCodexRecord(s.locator, s.locate, s.abort.signal, s.watch, waiting);
    const failed = expect(opening).rejects.toThrow('watch failed');
    await absent;
    s.handles.find(h => !h.disposed)!.failed(new Error('watch failed'));
    await failed;
    expect(s.handles.every(h => h.disposed)).toBe(true);
    expect(s.locate).toHaveBeenCalledOnce();
  });

  it('reports subscription setup failure without reading or falling back', async () => {
    const s = await setup();
    const dispose = vi.fn(async () => {});
    const watch: RecordDirectoryWatch = () => ({ ready: async () => { throw new Error('EACCES'); }, dispose });
    await expect(waitForCodexRecord(s.locator, s.locate, s.abort.signal, watch)).rejects.toThrow('EACCES');
    expect(s.locate).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
  });

  it.each(['producer exited', 'page closed', 'link disconnected'])('cancels on %s without another read', async reason => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const deadline = new CodexRecordDeadline(() => s.abort.abort(new Error('记录没出现')));
    let waiting!: () => void;
    const absent = new Promise<void>(resolve => { waiting = resolve; });
    const opening = waitForCodexRecord(s.locator, s.locate, s.abort.signal, s.watch, () => { deadline.start(Date.now()); waiting(); })
      .finally(() => deadline.stop());
    const failed = expect(opening).rejects.toThrow(reason);
    await absent;
    s.abort.abort(new Error(reason));
    await failed;
    expect(s.handles.every(h => h.disposed)).toBe(true);
    expect(s.locate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes actual directory creation/write notifications without a polling driver', async () => {
    const s = await setup(true);
    let waiting!: () => void;
    const absent = new Promise<void>(resolve => { waiting = resolve; });
    const opening = waitForCodexRecord(s.locator, s.locate, s.abort.signal, undefined, waiting);
    await absent;
    await s.create();
    await opening;

    const source = createCodexJsonlSource(s.locator);
    cleanups.push(() => source.stop());
    const poll = vi.spyOn(TailReader.prototype, 'start');
    cleanups.push(() => poll.mockRestore());
    let received!: () => void;
    const reply = new Promise<void>(resolve => { received = resolve; });
    await source.start({ onEntries: entries => {
      if (entries.some(entry => entry.event?.kind === 'message' && entry.event.text === '文件事件')) received();
    }, onReset: () => {} });
    await appendFile(s.file, JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '文件事件' }],
    } }) + '\n');
    await reply;
    expect(poll).not.toHaveBeenCalled();
  });

  it('accepts readiness at second 29 and clears the sole failure deadline', async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const expired = vi.fn(() => s.abort.abort(new Error('记录没出现')));
    const deadline = new CodexRecordDeadline(expired);
    let waiting!: () => void;
    const absent = new Promise<void>(resolve => { waiting = resolve; });
    const opening = waitForCodexRecord(s.locator, s.locate, s.abort.signal, s.watch, () => { deadline.start(Date.now()); waiting(); })
      .finally(() => deadline.stop());
    await absent;
    await vi.advanceTimersByTimeAsync(29_000);
    await s.create();
    s.fire();
    await opening;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(expired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails at second 30 without reading, retrying or extending the deadline', async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const deadline = new CodexRecordDeadline(() => s.abort.abort(new Error('记录没出现')));
    let waiting!: () => void;
    const absent = new Promise<void>(resolve => { waiting = resolve; });
    const opening = waitForCodexRecord(s.locator, s.locate, s.abort.signal, s.watch, () => { deadline.start(Date.now()); waiting(); })
      .finally(() => deadline.stop());
    const failed = expect(opening).rejects.toThrow('记录没出现');
    await absent;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(s.locate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(s.handles.every(h => h.disposed)).toBe(true);
  });
});
