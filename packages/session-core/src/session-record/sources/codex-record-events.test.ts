import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitFact, awaitPending } from '../../../../../tests/support/awaitFact';
import { CodexRecordDeadline, waitForCodexRecord, type RecordDirectoryWatch } from './codex-record-events';
import { SessionRecordNotFoundError } from './shared';
import { createCodexJsonlSource } from './codex-jsonl';
import { createSessionTimeline } from '../timeline';

const directoryDelivery = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../services/fs-watch/impl/directory-watch', async (load) => {
  const { DirectoryWatch } = await load<typeof import('../../services/fs-watch/impl/directory-watch')>();
  return {
    DirectoryWatch: class extends DirectoryWatch {
      constructor(...[root, deliver, resync, onError, recover]: ConstructorParameters<typeof DirectoryWatch>) {
        super(root, events => { if (directoryDelivery.enabled) deliver(events); },
          () => { if (directoryDelivery.enabled) resync(); }, onError, recover);
      }
    },
  };
});

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
    const poll = vi.spyOn(globalThis, 'setInterval');
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

  it('keeps both rollout appends in the timeline while Codex holds the file open', async () => {
    // macOS may defer directory events until an existing file's writer closes it. Keep the real file watcher
    // and hold back directory delivery so the case checks that precise condition on every OS.
    directoryDelivery.enabled = false;
    cleanups.push(() => { directoryDelivery.enabled = true; });
    const s = await setup();
    await s.create();
    const writer = await open(s.file, 'a');
    cleanups.push(() => writer.close());

    const timeline = await createSessionTimeline(createCodexJsonlSource(s.locator), { sessionId: 'codex-held-open' });
    cleanups.push(() => timeline.dispose());
    const write = (type: string, payload: object) => JSON.stringify({ type, payload }) + '\n';
    const message = (role: 'user' | 'assistant', text: string) => write('response_item', {
      type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    });
    const messages = () => timeline.getSnapshot().turns.flatMap(turn => turn.items)
      .flatMap(item => item.kind === 'message' ? [item.text] : []);
    const waitForUpdate = (step: string, ready: () => boolean) => awaitPending(step, new Promise<void>(resolve => {
      const stop = timeline.subscribe(timeline.getSnapshot().cursor, () => {
        if (ready()) { stop(); resolve(); }
      });
      cleanups.push(stop);
    }));

    expect(messages()).toEqual([]);
    const first = waitForUpdate('first append delivered to the timeline with the writer open', () => messages().includes('First part.'));
    await writer.write(write('event_msg', { type: 'task_started', turn_id: 'turn' })
      + message('user', 'Reply in two parts.') + message('assistant', 'First part.'));
    await first;
    expect(messages()).toEqual(['Reply in two parts.', 'First part.']);

    const second = waitForUpdate('second append and completion delivered with the writer open',
      () => timeline.getSnapshot().turns.at(-1)?.outcome?.kind === 'done');
    await writer.write(message('assistant', 'Second part.') + write('event_msg', { type: 'task_complete', turn_id: 'turn' }));
    await second;
    expect(messages()).toEqual(['Reply in two parts.', 'First part.', 'Second part.']);

    // Returning to the view starts a new subscription without a cursor from this timeline.
    const returned = vi.fn();
    const stop = timeline.subscribe({ epoch: 'reopened-view', seq: 0 }, returned);
    cleanups.push(stop);
    expect(returned).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        turns: [expect.objectContaining({ items: expect.arrayContaining([
          expect.objectContaining({ role: 'user', text: 'Reply in two parts.' }),
          expect.objectContaining({ role: 'assistant', text: 'First part.' }),
          expect.objectContaining({ role: 'assistant', text: 'Second part.' }),
        ]), outcome: expect.objectContaining({ kind: 'done' }) })],
      }),
    }));
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
