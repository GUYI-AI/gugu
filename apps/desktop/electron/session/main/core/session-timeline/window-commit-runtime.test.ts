import { describe, expect, it, vi } from 'vitest';
import { EventStreamSource } from '@gugu/session-wire';
import { createWindowCommitRuntime } from './window-commit-runtime';
import type { WindowCommittedEvent } from './window-commit-tap';
import type { WindowCommitCapture } from './window-commit-write';
import type { WindowCommitReceipt } from './window-commit-receipt';

const event = (sessionId = 'a', source: WindowCommittedEvent['source'] = 'live', referenceId = 'real-ref'): WindowCommittedEvent => ({ sessionId, source,
  turn: { id: 'runtime-turn', seq: 0, referenceId, initiator: 'user', items: [], outcome: { kind: 'done' } } });
function fixture() {
  const source = new EventStreamSource<WindowCommittedEvent>({ generation: 12 });
  const stream = { snapshot: vi.fn(async () => source.snapshot()), attach: vi.fn(async (push: Parameters<typeof source.subscribe>[0]) => source.subscribe(push)) };
  let writes = Promise.resolve();
  const saved: WindowCommitReceipt[] = [];
  const capture = vi.fn((e: WindowCommittedEvent, cursor: WindowCommitCapture['cursor'], committed: WindowCommitCapture['committed']) => ({ directory: '/unused', scope: 'a'.repeat(64), cursor, committed }));
  const persist = vi.fn((e: WindowCommittedEvent, context?: WindowCommitCapture) => {
    const write = writes.then(async () => {
      if (!context) return;
      const receipt: WindowCommitReceipt = { version: 1, sourceId: `source-${context.cursor.sequence}`, sessionId: e.sessionId,
        rowId: `${e.sessionId}:stored`, storedSeq: 17, referenceId: e.turn.referenceId!, firstCommitCursor: e.source === 'live' ? context.cursor : null,
        latestRevisionCursor: context.cursor, binding: { scope: context.scope, sourceLineage: 'b'.repeat(64), decoderVersion: 1 },
        source: { version: 1, bytes: 1, chunks: 1, stride: 17000, sha256: 'c'.repeat(64), physical: { dev: '1', ino: '2', mtimeNs: '3', ctimeNs: '4' } } };
      saved.push(receipt); await context.committed(receipt);
    }); writes = write.catch(() => {}); return write;
  });
  const project = vi.fn(async (receipt: WindowCommitReceipt) => ({ projectionId: `project-${receipt.sourceId}` })), report = vi.fn();
  const runtime = createWindowCommitRuntime({ capture, persist, project, report });
  return { source, stream, runtime, saved, capture, persist, project, report, drain: () => writes };
}

describe('non-waking commit reservations', () => {
  it('reserves while cold and delivers a whole turn completed before history authorization exactly once', async () => {
    const f = fixture(), failed = vi.fn(), owner = f.runtime.reserve('one', 'a', failed), cut = await owner.prepare();
    expect(f.stream.attach).not.toHaveBeenCalled(); expect(f.persist).not.toHaveBeenCalled();
    const result = vi.fn(), read = owner.read(cut).then(result);
    await f.runtime.attach(f.stream); f.source.emit(event()); await f.drain();
    expect(result).not.toHaveBeenCalled(); owner.authorize(); await read;
    const page = result.mock.calls[0][0];
    expect(page.entries).toMatchObject([{ kind: 'insert', referenceId: 'real-ref', rowId: 'a:stored', storedSeq: 17 }]);
    expect(page.next).toEqual({ ...cut, sequence: 1 }); owner.ack(page.next); owner.ack(page.next);
    expect(failed).not.toHaveBeenCalled(); owner.close(); f.runtime.close();
  });

  it('delivers the final B committed before ACK without relying on a notification or later turn', async () => {
    const f = fixture(); await f.runtime.attach(f.stream);
    const owner = f.runtime.reserve('one', 'a', vi.fn()), cut = await owner.prepare(); owner.authorize();
    f.source.emit(event()); await f.drain(); const first = await owner.read(cut); expect(first.hasMore).toBe(false);
    f.source.emit(event('a', 'live', 'last-B')); await f.drain(); owner.ack(first.next);
    expect((await owner.read(first.next)).entries[0].referenceId).toBe('last-B'); f.runtime.close();
  });

  it('keeps historical null-first revisions update-only and never captures replayed historical inserts', async () => {
    const f = fixture(); await f.runtime.attach(f.stream);
    const owner = f.runtime.reserve('one', 'a', vi.fn()), cut = await owner.prepare(); owner.authorize();
    f.source.emit(event('a', 'replay')); f.source.emit(event('a', 'backfill')); await f.drain();
    expect(f.capture).toHaveBeenCalledTimes(1); expect(f.persist).toHaveBeenCalledTimes(2);
    const page = await owner.read(cut);
    expect(page.entries[0]).toMatchObject({ kind: 'update', firstCommitCursor: null, latestRevisionCursor: { sequence: 2 } }); f.runtime.close();
  });

  it('fails only owners of a failed projection and preserves ordinary persistence and the other conversation', async () => {
    const f = fixture(); await f.runtime.attach(f.stream);
    const failedA = vi.fn(), failedB = vi.fn(), a = f.runtime.reserve('one', 'a', failedA), b = f.runtime.reserve('two', 'b', failedB);
    await a.prepare(); const cutB = await b.prepare(); a.authorize(); b.authorize();
    f.project.mockRejectedValueOnce(new Error('projection I/O')); f.source.emit(event()); await f.drain(); await Promise.resolve();
    f.source.emit(event('b')); await f.drain(); expect((await b.read(cutB)).entries[0].rowId).toBe('b:stored');
    expect(failedA).toHaveBeenCalledTimes(1); expect(failedB).not.toHaveBeenCalled();
    expect(f.runtime.inspect()).toEqual({ owners: 1 }); f.runtime.close();
  });

  it('releases an empty long read and discards late projection completion for a reused subscription ID', async () => {
    const f = fixture(); await f.runtime.attach(f.stream);
    const a = f.runtime.reserve('same', 'a', vi.fn()), cut = await a.prepare(); a.authorize();
    const reading = a.read(cut), rejected = expect(reading).rejects.toMatchObject({ code: 'unsubscribed' });
    const pending = Promise.withResolvers<{ projectionId: string }>(); f.project.mockReturnValueOnce(pending.promise);
    f.source.emit(event()); await vi.waitFor(() => expect(f.project).toHaveBeenCalledTimes(1));
    a.close(); await rejected;
    const b = f.runtime.reserve('same', 'b', vi.fn()), after = await b.prepare(); b.authorize();
    pending.resolve({ projectionId: 'old-late' }); await f.drain();
    const seen = vi.fn(), next = b.read(after).then(seen); await Promise.resolve(); expect(seen).not.toHaveBeenCalled();
    f.source.emit(event('b')); await f.drain(); await next;
    expect(seen.mock.calls[0][0].entries.map((e: { rowId: string }) => e.rowId)).toEqual(['b:stored']); f.runtime.close();
  });

  it('invalidates old owners on a worker epoch change and keeps the reservation capacity fixed', async () => {
    const f = fixture(); await f.runtime.attach(f.stream);
    const failed = vi.fn(), owner = f.runtime.reserve('old', 'a', failed), cut = await owner.prepare(); owner.authorize();
    const rejected = expect(owner.read(cut)).rejects.toMatchObject({ code: 'live_source_gap' }); f.runtime.invalidate(); await rejected;
    expect(failed).toHaveBeenCalledTimes(1);
    const fresh = f.runtime.reserve('fresh', 'a', vi.fn()); expect((await fresh.prepare()).workerEpoch).not.toBe(cut.workerEpoch);
    for (let n = 0; n < 31; n++) f.runtime.reserve(`slot-${n}`, 'b', vi.fn());
    expect(() => f.runtime.reserve('overflow', 'b', vi.fn())).toThrow(/Too many/); f.runtime.close();
  });

  it('cancels a prepared owner while shared source metadata is still pending without cancelling another owner', async () => {
    const f = fixture(); await f.runtime.attach(f.stream); f.runtime.invalidate();
    const snapshot = Promise.withResolvers<ReturnType<typeof f.source.snapshot>>(); f.stream.snapshot.mockReturnValueOnce(snapshot.promise);
    const failed = vi.fn(), a = f.runtime.reserve('one', 'a', failed), b = f.runtime.reserve('two', 'b', vi.fn());
    const first = a.prepare(), second = b.prepare(), rejected = expect(first).rejects.toMatchObject({ code: 'unsubscribed' });
    a.close(); await rejected; expect(failed).not.toHaveBeenCalled();
    snapshot.resolve(f.source.snapshot()); await second; expect(f.runtime.inspect()).toEqual({ owners: 1 }); f.runtime.close();
  });

  it('fails a cold prepared owner and settles its empty read when source attachment rejects', async () => {
    const f = fixture(), failed = vi.fn(), owner = f.runtime.reserve('one', 'a', failed), cut = await owner.prepare(); owner.authorize();
    const rejected = expect(owner.read(cut)).rejects.toMatchObject({ code: 'live_source_gap' });
    f.stream.attach.mockRejectedValueOnce(new Error('private attach failed'));
    await expect(f.runtime.attach(f.stream)).rejects.toThrow('private attach failed'); await rejected;
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'live_source_gap' }));
    expect(f.runtime.inspect()).toEqual({ owners: 0 }); expect(f.persist).not.toHaveBeenCalled(); f.runtime.close();
  });

  it('bounds pending projections together with published unacknowledged references', async () => {
    const f = fixture(); await f.runtime.attach(f.stream);
    const failed = vi.fn(), a = f.runtime.reserve('one', 'a', failed), cut = await a.prepare(); a.authorize();
    const gate = Promise.withResolvers<{ projectionId: string }>(); f.project.mockReturnValueOnce(gate.promise);
    const reading = expect(a.read(cut)).rejects.toMatchObject({ code: 'live_buffer_overflow' });
    f.source.emit(event()); await vi.waitFor(() => expect(f.project).toHaveBeenCalledTimes(1));
    for (let n = 1; n <= 64; n++) f.source.emit(event('a', 'live', `ref-${n}`));
    await reading; expect(failed).toHaveBeenCalledTimes(1); expect(f.capture).toHaveBeenCalledTimes(64);
    // Reusing the released owner cannot allocate another queue behind the held job.
    const bFailed = vi.fn(), b = f.runtime.reserve('one', 'a', bFailed), after = await b.prepare(); b.authorize();
    const rejected = expect(b.read(after)).rejects.toMatchObject({ code: 'live_buffer_overflow' });
    f.source.emit(event('a', 'live', 'replacement')); await rejected;
    expect(f.capture).toHaveBeenCalledTimes(64); expect(bFailed).toHaveBeenCalledTimes(1);
    gate.resolve({ projectionId: 'held' }); await f.drain();
    expect(f.persist).toHaveBeenCalledTimes(66); f.runtime.close();
  });

  it('charges an already delivered unacknowledged page against the pending projection allowance', async () => {
    const f = fixture(); await f.runtime.attach(f.stream);
    const failed = vi.fn(), owner = f.runtime.reserve('one', 'a', failed), cut = await owner.prepare(); owner.authorize();
    f.source.emit(event()); await f.drain(); await owner.read(cut);
    const gate = Promise.withResolvers<{ projectionId: string }>(); f.project.mockReturnValueOnce(gate.promise);
    f.source.emit(event('a', 'live', 'second')); await vi.waitFor(() => expect(f.project).toHaveBeenCalledTimes(2));
    for (let n = 2; n < 64; n++) f.source.emit(event('a', 'live', `ref-${n}`));
    expect(failed).not.toHaveBeenCalled(); f.source.emit(event('a', 'live', 'overflow'));
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'live_buffer_overflow' }));
    expect(f.capture).toHaveBeenCalledTimes(64);
    gate.resolve({ projectionId: 'held' }); await f.drain(); f.runtime.close();
  });
});
