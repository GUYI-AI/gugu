import { describe, expect, it, vi } from 'vitest';
import { EventStreamSource, type LiveUpdate } from '@gugu/session-wire';
import type { AttachOptions } from '@gugu/session-wire/api';
import { createWindowCommitTap } from './window-commit-tap';

const event = (source: 'live' | 'replay' = 'live') => ({ sessionId: 's', source, turn: {
  id: 'turn', seq: 0, referenceId: 'actual-reference', initiator: 'user' as const, items: [],
} });
function fixture() {
  const source = new EventStreamSource<ReturnType<typeof event>>({ generation: 7 });
  let push!: (update: LiveUpdate) => void, attachment: AttachOptions | undefined;
  const stream = { snapshot: vi.fn(async () => source.snapshot()), attach: vi.fn(async (next: typeof push, options?: AttachOptions) => {
    push = next; attachment = options; return source.subscribe(next);
  }) };
  const commit = vi.fn(), failed = vi.fn(), tap = createWindowCommitTap({ onCommit: commit, onInvalidated: failed });
  return { source, stream, commit, failed, tap, push: (update: LiveUpdate) => push(update), reattach: () => attachment?.onReattach?.() };
}

describe('the authoritative private committed-event tap', () => {
  it('uses the real event generation/sequence and preserves actual source classification without cloning the turn', async () => {
    const f = fixture(); await f.tap.attach(f.stream);
    expect(f.tap.current()).toEqual({ generation: 7, sequence: 0 });
    const first = event(); f.source.emit(first); f.source.emit(event('replay'));
    expect(f.commit.mock.calls[0]).toEqual([first, { generation: 7, sequence: 1 }]);
    expect(f.commit.mock.calls[0][0]).toBe(first);
    expect(f.commit.mock.calls[1][0].source).toBe('replay');
    expect(f.commit.mock.calls[1][1]).toEqual({ generation: 7, sequence: 2 });
    expect(Object.isFrozen(f.tap.current())).toBe(true); expect(f.failed).not.toHaveBeenCalled();
    f.tap.close(); expect(f.source.subscriberCount).toBe(0);
  });

  it('fails a missing source interval once while forwarding ordinary canonical persistence with no capture proof', async () => {
    const f = fixture(); await f.tap.attach(f.stream);
    f.push({ generation: 7, baseSequence: 3, sequence: 4, timestamp: 0, delta: { event: event() } });
    f.source.emit(event());
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.tap.current()).toBeNull();
    expect(f.commit.mock.calls.map(call => call[1])).toEqual([null, null]);
    f.tap.close();
  });

  it('does not resume old owners on reconnect; only explicit new-opening sampling establishes a new boundary', async () => {
    const f = fixture(); await f.tap.attach(f.stream); f.reattach(); f.reattach();
    f.source.emit(event()); expect(f.tap.current()).toBeNull(); expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.commit.mock.calls[0][1]).toBeNull();
    expect(await f.tap.resample()).toEqual({ generation: 7, sequence: 1 });
    f.source.emit(event()); expect(f.commit.mock.calls[1][1]).toEqual({ generation: 7, sequence: 2 });
    expect(f.failed).toHaveBeenCalledTimes(1); f.tap.close();
  });

  it('fails an event arriving before the awaited startup barrier instead of inventing a retained replay', async () => {
    const f = fixture(), snapshot = Promise.withResolvers<ReturnType<typeof f.source.snapshot>>();
    const entered = Promise.withResolvers<void>();
    f.stream.snapshot.mockImplementationOnce(() => { entered.resolve(); return snapshot.promise; });
    const attaching = f.tap.attach(f.stream); await entered.promise;
    expect(f.source.subscriberCount).toBe(1); f.source.emit(event()); snapshot.resolve(f.source.snapshot()); await attaching;
    expect(f.failed).toHaveBeenCalledTimes(1); expect(f.commit.mock.calls[0][1]).toBeNull(); expect(f.tap.current()).toBeNull();
    await f.tap.resample(); expect(f.tap.current()).toEqual({ generation: 7, sequence: 1 }); f.tap.close();
  });

  it('releases a late attachment ACK after close and never forwards late events or failed status', async () => {
    const f = fixture(), ack = Promise.withResolvers<() => void>();
    f.stream.attach.mockImplementationOnce(async push => { const release = f.source.subscribe(push); await ack.promise; return release; });
    const attaching = f.tap.attach(f.stream); f.tap.close(); await attaching;
    f.source.emit(event()); expect(f.commit).not.toHaveBeenCalled();
    ack.resolve(() => {}); await Promise.resolve(); await Promise.resolve();
    expect(f.source.subscriberCount).toBe(0); expect(f.failed).not.toHaveBeenCalled();
  });

  it('settles close during the one shared metadata wait and discards an old snapshot', async () => {
    const f = fixture(), snapshot = Promise.withResolvers<ReturnType<typeof f.source.snapshot>>();
    f.stream.snapshot.mockImplementationOnce(() => snapshot.promise);
    const attaching = f.tap.attach(f.stream); await Promise.resolve(); await Promise.resolve();
    const first = f.tap.resample(), duplicate = f.tap.resample(); expect(first).toBe(duplicate);
    f.tap.close(); expect(await first).toBeNull(); await attaching;
    snapshot.resolve(f.source.snapshot()); await Promise.resolve();
    expect(f.tap.current()).toBeNull(); expect(f.source.subscriberCount).toBe(0);
  });

  it('reports a metadata error without disabling the canonical listener or silently retrying a failed view', async () => {
    const f = fixture(); f.stream.snapshot.mockRejectedValueOnce(new Error('snapshot I/O failed'));
    await f.tap.attach(f.stream); expect(f.failed).toHaveBeenCalledTimes(1); expect(f.tap.current()).toBeNull();
    f.source.emit(event()); expect(f.commit.mock.calls[0][1]).toBeNull();
    expect(f.stream.snapshot).toHaveBeenCalledTimes(1); f.tap.close();
  });

  it('forwards the actual canonical event when a gap failure observer and its diagnostic reporter both throw', async () => {
    const source = new EventStreamSource<ReturnType<typeof event>>({ generation: 9 });
    const commit = vi.fn(), diagnostic = vi.fn(() => { throw new Error('logging failed'); });
    const tap = createWindowCommitTap({ onCommit: commit,
      onInvalidated() { throw new Error('notification failed'); }, onObservationError: diagnostic });
    await tap.attach({ snapshot: async () => source.snapshot(), attach: async push => source.subscribe(update => {
      if (update.sequence !== 1) push(update);
    }) });
    source.emit(event()); const actual = event(); expect(() => source.emit(actual)).not.toThrow();
    expect(commit).toHaveBeenCalledExactlyOnceWith(actual, null);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'notification failed' }));
    expect(tap.current()).toBeNull(); tap.close();
  });
});
