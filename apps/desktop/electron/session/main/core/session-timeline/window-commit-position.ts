import type { WindowLiveCursor, WindowLivePositionRequest, WindowLivePositionResult } from '@gugu/session-wire/session-window-live';
import type { WindowOpeningLease } from './window-opening';
type Committed = Extract<WindowLivePositionResult, { kind: 'committed' }>;
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const epoch = (a: WindowLiveCursor, b: WindowLiveCursor) => a.workerEpoch === b.workerEpoch && a.storeEpoch === b.storeEpoch;
const inFlight = new WeakMap<WindowOpeningLease, number>();
const outstanding = new Set<Promise<unknown>>();
function wait<T>(lease: WindowOpeningLease, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return lease.wait(signal => {
    // Released owners cannot admit unbounded old writer waits while a shared
    // canonical/projection operation remains pending. Charge until it actually settles.
    if (outstanding.size >= 64) throw failure('window_capacity', 'Too many outstanding position operations');
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }); outstanding.add(work);
    return work.finally(() => outstanding.delete(work));
  });
}

/** A missing descriptor is never proof of an uncommitted turn. Only the
 * authority's scalar active/reference answer can authorize that branch.
 * The owner races both writer/probe waits; late old-worker answers cannot
 * escape its final lease/epoch check. No retry or history/JSON scan occurs. */
export async function lookupWindowCommitPosition(lease: WindowOpeningLease, input: WindowLivePositionRequest, ports: {
  durable(signal: AbortSignal): Promise<Committed | null>;
  primaryActive(signal: AbortSignal): Promise<boolean>;
}): Promise<WindowLivePositionResult> {
  const applied = { ...input.appliedCursor }, referenceId = input.referenceId, sampledCursor = lease.sample(applied), count = inFlight.get(lease) ?? 0;
  if (count >= 2) throw failure('window_capacity', 'Too many active position queries');
  inFlight.set(lease, count + 1);
  const current = () => {
    const now = lease.sample(applied);
    if (!epoch(now, sampledCursor)) throw failure('live_source_gap', 'The commit worker changed during the position query');
  };
  const committed = (value: Committed): Committed => {
    current();
    if (value.position.referenceId !== referenceId || !epoch(value.latestRevisionCursor, sampledCursor))
      throw failure('needs_location', 'The committed reference has no position in this live epoch');
    return value;
  };
  try {
    const known = await wait(lease, ports.durable); if (known) return committed(known);
    const active = await wait(lease, ports.primaryActive); current();
    // A commit can complete while the primary answer is travelling back.
    // Wait the same writer again before deciding, with this lease's lifetime.
    const arrived = await wait(lease, ports.durable); if (arrived) return committed(arrived);
    current();
    if (!active) throw failure('needs_location', 'No durable position or primary active proof exists');
    return { kind: 'not_committed', sampledCursor };
  } finally {
    const remaining = (inFlight.get(lease) ?? 1) - 1;
    if (remaining) inFlight.set(lease, remaining); else inFlight.delete(lease);
  }
}
