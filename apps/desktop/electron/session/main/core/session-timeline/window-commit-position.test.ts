import { afterEach, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { EventStreamSource } from '@gugu/session-wire';
import { acpRuntimeApiContract } from '@gugu/session-core/acp';
import { defineContract } from '@gugu/session-wire/api';
import { createTestWire } from '@gugu/session-wire/testing';
import type { WindowLivePositionResult } from '@gugu/session-wire/session-window-live';
import { createWindowCommitRuntime } from './window-commit-runtime';
import type { WindowCommittedEvent } from './window-commit-tap';
import { lookupWindowCommitPosition as lookup } from './window-commit-position';

type Committed = Extract<WindowLivePositionResult, { kind: 'committed' }>;
const runtimes: ReturnType<typeof createWindowCommitRuntime>[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); });
async function fixture() {
  const events = new EventStreamSource<WindowCommittedEvent>({ generation: 9 });
  const runtime = createWindowCommitRuntime({ persist: vi.fn(async () => {}), capture: (event, cursor, committed) => ({
    directory: '/unused', scope: 'a'.repeat(64), cursor, committed }),
    project: async () => { throw new Error('No projection is produced by this scalar lookup fixture'); }, report: vi.fn() }); runtimes.push(runtime);
  await runtime.attach({ snapshot: async () => events.snapshot(), attach: async push => events.subscribe(push) });
  const failed = vi.fn(), lease = runtime.reserve('view', 'c', failed), after = await lease.prepare(); lease.authorize();
  const request = { conversationId: 'c', subscriptionId: 'view', referenceId: 'A', appliedCursor: after };
  const known = (first: Committed['firstCommitCursor'] = after): Committed => ({ kind: 'committed',
    position: { projectionId: 'durable-version', rowId: 'c:0', storedSeq: 0, referenceId: 'A' }, firstCommitCursor: first, latestRevisionCursor: after });
  return { runtime, events, failed, lease, after, request, known };
}
const absent = () => vi.fn(async (): Promise<Committed | null> => null);

it.each(['committed', 'not_committed'] as const)('releases cancellation waiters after serial %s queries on one open lease', async kind => {
  const f = await fixture(), signals = new Set<AbortSignal>();
  const observe = <T>(value: T) => async (signal: AbortSignal) => {
    signals.add(signal);
    expect(signal.aborted).toBe(false);
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);
    return value;
  };
  for (let index = 0; index < 128; index++) {
    expect(await lookup(f.lease, f.request, {
      durable: observe(kind === 'committed' ? f.known() : null), primaryActive: observe(true),
    })).toMatchObject({ kind });
    expect(signals.size).toBe(1);
    for (const signal of signals) {
      expect(signal.aborted).toBe(false);
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    }
  }
});
it('removes a cancellation waiter when its operation rejects without closing the lease', async () => {
  const f = await fixture(); let signal!: AbortSignal;
  await expect(lookup(f.lease, f.request, { durable: async value => { signal = value; throw new Error('storage failed'); }, primaryActive: async () => true }))
    .rejects.toThrow('storage failed');
  expect(signal.aborted).toBe(false); expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  expect(await lookup(f.lease, f.request, { durable: async () => f.known(), primaryActive: async () => true })).toEqual(f.known());
});

it('prefers a durable position and preserves null-first historical updates without asking the worker', async () => {
  const f = await fixture(), primaryActive = vi.fn(async () => true);
  expect(await lookup(f.lease, f.request, { durable: async () => f.known(), primaryActive })).toEqual(f.known());
  expect(await lookup(f.lease, f.request, { durable: async () => f.known(null), primaryActive })).toEqual(f.known(null));
  expect(primaryActive).not.toHaveBeenCalled();
});
it('requires positive primary proof and returns the original pre-probe tap cursor', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), probe = Promise.withResolvers<boolean>(), durable = absent();
  const result = lookup(f.lease, f.request, { durable, primaryActive: () => { entered.resolve(); return probe.promise; } }); await entered.promise;
  f.events.emit({ sessionId: 'another-session', source: 'live', turn: { id: 'other', seq: 0, initiator: 'user', items: [] } });
  probe.resolve(true); expect(await result).toEqual({ kind: 'not_committed', sampledCursor: f.after }); expect(durable).toHaveBeenCalledTimes(2);
});
it('does not turn missing, incomplete, foreign or cross-epoch durable positions into active proof', async () => {
  const f = await fixture(), primaryActive = vi.fn(async () => false);
  await expect(lookup(f.lease, f.request, { durable: absent(), primaryActive })).rejects.toMatchObject({ code: 'needs_location' });
  primaryActive.mockClear();
  await expect(lookup(f.lease, f.request, { durable: async () => { throw Object.assign(new Error('manifest pending'), { code: 'needs_location' }); }, primaryActive })).rejects.toMatchObject({ code: 'needs_location' });
  expect(primaryActive).not.toHaveBeenCalled();
  await expect(lookup(f.lease, f.request, { durable: async () => ({ ...f.known(), latestRevisionCursor: { ...f.after, workerEpoch: 'old-worker' } }), primaryActive })).rejects.toMatchObject({ code: 'needs_location' });
  await expect(lookup(f.lease, { ...f.request, referenceId: 'foreign' }, { durable: async () => f.known(), primaryActive })).rejects.toMatchObject({ code: 'needs_location' });
});
it('observes a durable commit arriving while the primary A answer is in flight', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), probe = Promise.withResolvers<boolean>(), durable = absent();
  durable.mockResolvedValueOnce(null).mockResolvedValueOnce(f.known());
  const result = lookup(f.lease, f.request, { durable, primaryActive: () => { entered.resolve(); return probe.promise; } }); await entered.promise;
  probe.resolve(true); expect(await result).toEqual(f.known());
});
it('settles an old writer wait on unsubscribe without letting its late answer act on the replacement owner', async () => {
  const f = await fixture(), pending = Promise.withResolvers<Committed | null>(), entered = Promise.withResolvers<void>();
  const result = lookup(f.lease, f.request, { durable: () => { entered.resolve(); return pending.promise; }, primaryActive: async () => true });
  const rejected = expect(result).rejects.toMatchObject({ code: 'unsubscribed' }); await entered.promise; f.lease.close(); await rejected;
  const next = f.runtime.reserve('view', 'c', vi.fn()), after = await next.prepare(); next.authorize(); pending.resolve(f.known());
  expect(await lookup(next, { ...f.request, appliedCursor: after }, { durable: absent(), primaryActive: async () => true }))
    .toEqual({ kind: 'not_committed', sampledCursor: after });
});
it('invalidates a late old-worker proof and releases both pending queries on worker loss', async () => {
  const f = await fixture(), pending = Promise.withResolvers<boolean>(), entered = Promise.withResolvers<void>();
  const result = lookup(f.lease, f.request, { durable: absent(), primaryActive: () => { entered.resolve(); return pending.promise; } });
  const rejected = expect(result).rejects.toMatchObject({ code: 'unsubscribed' }); await entered.promise; f.runtime.invalidate(); await rejected;
  pending.resolve(true); expect(f.failed).toHaveBeenCalledTimes(1);
});
it('bounds concurrent proof work and validates applied epoch before starting it', async () => {
  const f = await fixture(), pending = Promise.withResolvers<Committed | null>(), durable = vi.fn(() => pending.promise);
  await expect(lookup(f.lease, { ...f.request, appliedCursor: { ...f.after, sequence: 1 } }, { durable, primaryActive: async () => true })).rejects.toMatchObject({ code: 'invalid_cursor' });
  expect(durable).not.toHaveBeenCalled();
  const a = lookup(f.lease, f.request, { durable, primaryActive: async () => true }), b = lookup(f.lease, f.request, { durable, primaryActive: async () => true });
  const rejectedA = expect(a).rejects.toMatchObject({ code: 'unsubscribed' }), rejectedB = expect(b).rejects.toMatchObject({ code: 'unsubscribed' });
  await expect(lookup(f.lease, f.request, { durable, primaryActive: async () => true })).rejects.toMatchObject({ code: 'window_capacity' });
  f.lease.close(); await Promise.all([rejectedA, rejectedB]); pending.resolve(null);
});
it.each(['unsubscribe', 'worker', 'store', 'close'])('cancels the actual private wire request on %s', async reason => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), ended = vi.fn();
  const contract = defineContract({ windowActiveReference: acpRuntimeApiContract.windowActiveReference });
  const wire = createTestWire(contract, { windowActiveReference: (_input, { signal }) => new Promise<boolean>(resolve => {
    if (!signal) throw new Error('The actual wire call did not carry cancellation');
    signal.addEventListener('abort', () => { ended(); resolve(false); }, { once: true }); entered.resolve();
  }) });
  try {
    const query = lookup(f.lease, f.request, { durable: absent(),
      primaryActive: signal => wire.client.windowActiveReference({ sessionId: 'c', referenceId: 'A' }, { signal }) });
    const rejected = expect(query).rejects.toMatchObject({ code: 'unsubscribed' }); await entered.promise;
    if (reason === 'unsubscribe') f.lease.close();
    else if (reason === 'worker') f.runtime.invalidate();
    else if (reason === 'store') f.runtime.invalidateStore();
    else f.runtime.close();
    await rejected;
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1), { timeout: 100 });
  } finally { wire.dispose(); }
});
it('keeps abandoned writer operations within a global bound until their actual completion', async () => {
  const held = Promise.withResolvers<Committed | null>();
  try {
    for (let index = 0; index < 64; index++) {
      const f = await fixture(), entered = Promise.withResolvers<void>();
      const query = lookup(f.lease, f.request, { durable: () => { entered.resolve(); return held.promise; }, primaryActive: async () => true });
      const rejected = expect(query).rejects.toMatchObject({ code: 'unsubscribed' });
      await entered.promise; f.lease.close(); await rejected;
    }
    const f = await fixture();
    await expect(lookup(f.lease, f.request, { durable: absent(), primaryActive: async () => true }))
      .rejects.toMatchObject({ code: 'window_capacity' });
  } finally { held.resolve(null); }
  await new Promise(resolve => setImmediate(resolve));
  const f = await fixture();
  expect(await lookup(f.lease, f.request, { durable: absent(), primaryActive: async () => true })).toMatchObject({ kind: 'not_committed' });
});
