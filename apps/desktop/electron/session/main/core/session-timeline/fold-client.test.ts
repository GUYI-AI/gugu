import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineArchive } from '@gugu/session-core/session-record';
import { createFoldClient } from './fold-client';
import type { FoldReply, FoldRequest } from './fold';

vi.mock('../../worker-manifest', () => ({ desktopWorkerPath: () => '/nowhere' }));

class FakeWorker extends EventEmitter {
  posted: unknown[] = [];
  postMessage(message: unknown) { this.posted.push(message); }
  unref() {}
  async terminate() { return 0; }
  reply(message: FoldReply) { this.emit('message', message); }
}

const request = { locator: { harness: 'claude', providerSessionId: 's', roots: [] }, sessionId: 's', checkpoint: '/c.json' } as FoldRequest;
const head = { epoch: 'e', sourceBytes: 9, parser: { transcript: { committed: [], active: null } } } as unknown as TimelineArchive;
const turn = (id: string) => ({ id }) as never;
const yielded = () => new Promise((resolve) => setImmediate(resolve));

function client() {
  const workers: FakeWorker[] = [];
  const warn = vi.fn();
  const fold = createFoldClient(warn, () => { const one = new FakeWorker(); workers.push(one); return one as unknown as Worker; });
  return { fold, workers, warn };
}

describe('fold client', () => {
  it('puts the archive back together, taking each slice only after the event loop ran', async () => {
    const { fold, workers } = client();
    const done = fold.fold(request);
    const worker = workers[0];
    expect(worker.posted).toEqual([{ id: 1, request }]);
    worker.reply({ id: 1, head, turns: 3 });
    expect(worker.posted).toHaveLength(1);
    await yielded();
    expect(worker.posted.at(-1)).toEqual({ id: 1, ack: true });
    worker.reply({ id: 1, turns: [turn('a'), turn('b')] });
    await yielded();
    worker.reply({ id: 1, turns: [turn('c')] });
    const archive = await done;
    expect(archive?.parser.transcript.committed).toEqual([turn('a'), turn('b'), turn('c')]);
    expect(archive?.sourceBytes).toBe(9);
    await yielded();
    // The last slice completes the archive: nothing more to ask for.
    expect(worker.posted.filter((one) => (one as { ack?: true }).ack)).toHaveLength(2);
  });

  it('an archive without turns or a record without a resume point needs no slices', async () => {
    const { fold, workers } = client();
    const empty = fold.fold(request);
    workers[0].reply({ id: 1, head, turns: 0 });
    expect((await empty)?.parser.transcript.committed).toEqual([]);
    const none = fold.fold(request);
    workers[0].reply({ id: 2, archive: null });
    expect(await none).toBeNull();
  });

  it('fails the folds in flight when the thread fails or exits, and starts a new thread for the next one', async () => {
    const { fold, workers, warn } = client();
    const failed = fold.fold(request);
    workers[0].reply({ id: 1, error: { name: 'SessionRecordNotFoundError', message: 'no record' } });
    await expect(failed).rejects.toMatchObject({ name: 'SessionRecordNotFoundError', message: 'no record' });
    workers[0].reply({ id: 1, warning: 'checkpoint not written: EACCES' });
    expect(warn).toHaveBeenCalledWith('sessionTimeline: fold thread', { warning: 'checkpoint not written: EACCES' });

    const lost = fold.fold(request);
    workers[0].emit('exit', 1);
    await expect(lost).rejects.toThrow('exited (1)');
    void fold.fold(request);
    expect(workers).toHaveLength(2);
  });
});
