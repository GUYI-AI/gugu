import { randomUUID } from 'node:crypto';
import { createWindowCommitTap, type WindowCommittedEvent } from './window-commit-tap';
import { createWindowCommitJournal, type WindowLiveCursor, type WindowCommitReference } from './window-commit-journal';
import type { WindowCommitCapture } from './window-commit-write';
import type { WindowCommitReceipt } from './window-commit-receipt';

type Fault = Error & { code: string };
type Journal = ReturnType<typeof createWindowCommitJournal>;
type Owner = { conversationId: string; failed(error: Fault): void; journal?: Journal; after?: WindowLiveCursor; closed: boolean; released: ReturnType<typeof Promise.withResolvers<null>> };
const fault = (code: string, message: string): Fault => Object.assign(new Error(message), { code });
const equal = (a: WindowLiveCursor, b: WindowLiveCursor) => a.workerEpoch === b.workerEpoch && a.storeEpoch === b.storeEpoch && a.sequence === b.sequence;

/** Main-owned reservations exist even before a worker does. attach must be awaited
 * inside lazyWorker.onSpawned; this module never calls get/start or retains turns. */
export function createWindowCommitRuntime(ports: {
  persist(event: WindowCommittedEvent, capture?: WindowCommitCapture): Promise<void>;
  capture(event: WindowCommittedEvent, cursor: WindowLiveCursor, committed: WindowCommitCapture['committed']): WindowCommitCapture & {
    project?(receipt: WindowCommitReceipt): Promise<{ projectionId: string }>;
  };
  project(receipt: WindowCommitReceipt): Promise<{ projectionId: string }>;
  report(error: unknown): void;
}) {
  const owners = new Map<string, Owner>();
  let workerEpoch = randomUUID(), storeEpoch = randomUUID(), closed = false;
  let tap: ReturnType<typeof createWindowCommitTap> | undefined;
  const report = (error: unknown) => { try { ports.report(error); } catch { /* Reporting cannot alter canonical persistence or other owners. */ } };
  const notify = (owner: Owner, error: Fault) => { try { owner.failed(error); } catch (cause) { report(cause); } };
  function fail(owner: Owner, error: Fault) {
    if (owner.closed) return;
    if (owner.journal) owner.journal.fail(error.code, error.message);
    else { owner.closed = true; owner.released.resolve(null); for (const [id, value] of owners) if (value === owner) owners.delete(id); notify(owner, error); }
  }
  function invalidated(error: Fault) {
    workerEpoch = randomUUID();
    for (const owner of [...owners.values()]) fail(owner, error);
  }
  function coordinate(sequence: number): WindowLiveCursor { return { workerEpoch, storeEpoch, sequence }; }
  function dispatch(event: WindowCommittedEvent, raw: { sequence: number } | null) {
    const selected = [...owners.values()].filter(owner => owner.conversationId === event.sessionId);
    let capture: ReturnType<typeof ports.capture> | undefined;
    if (raw && event.source !== 'replay' && selected.length) {
      const at = Object.freeze(coordinate(raw.sequence));
      for (const owner of selected) if (!owner.journal) fail(owner, fault('scope_changed', 'The session started before its history boundary was prepared'));
      const recipients = selected.filter(owner => !owner.closed);
      if (recipients.length) {
        try {
          let project = ports.project;
          capture = ports.capture(event, at, async receipt => {
            if (!receipt) return;
            if (receipt.sessionId !== event.sessionId || receipt.referenceId !== event.turn.referenceId || !equal(receipt.latestRevisionCursor, at))
              throw fault('live_identity_mismatch', 'The persisted commit does not match its runtime source');
            const { projectionId } = await project(receipt);
            const values = { referenceId: receipt.referenceId, rowId: receipt.rowId, storedSeq: receipt.storedSeq,
              projectionId, latestRevisionCursor: receipt.latestRevisionCursor };
            const entry: WindowCommitReference = event.source === 'live' && receipt.firstCommitCursor && equal(receipt.firstCommitCursor, at)
              ? { ...values, kind: 'insert', firstCommitCursor: receipt.firstCommitCursor }
              : { ...values, kind: 'update', firstCommitCursor: receipt.firstCommitCursor };
            for (const owner of recipients) if (!owner.closed) owner.journal!.publish(entry);
          });
          project = capture.project ?? project;
        } catch (error) {
          for (const owner of recipients) fail(owner, fault('live_capture_failed', String(error)));
          report(error);
        }
      }
    }
    const failed = (error: unknown) => {
      for (const owner of selected) fail(owner, fault('live_commit_failed', String(error)));
      report(error);
    };
    try { void ports.persist(event, capture).catch(failed); } catch (error) { failed(error); }
  }
  return {
    async attach(source: Parameters<ReturnType<typeof createWindowCommitTap>['attach']>[0]) {
      if (closed) return;
      if (tap) { invalidated(fault('live_source_gap', 'The committed-event worker was replaced')); tap.close(); }
      const selected = createWindowCommitTap({ onCommit: dispatch, onInvalidated: invalidated, onObservationError: report }); tap = selected;
      try { await selected.attach(source); }
      catch (error) {
        if (tap === selected) { invalidated(fault('live_source_gap', `Committed-event attachment failed: ${String(error)}`)); tap = undefined; }
        selected.close(); throw error;
      }
    },
    /** Caller registers before awaiting lifecycle proof. prepare samples metadata only. */
    reserve(id: string, conversationId: string, failed: Owner['failed']) {
      if (closed) throw fault('unsubscribed', 'Commit runtime is closed');
      if (!id || !conversationId || id.length > 2048 || conversationId.length > 2048 || owners.has(id)) throw fault('invalid_subscription', 'Invalid or occupied commit subscription');
      if (owners.size >= 32) throw fault('window_capacity', 'Too many commit subscriptions');
      const owner: Owner = { conversationId, failed, closed: false, released: Promise.withResolvers<null>() }; owners.set(id, owner);
      const active = () => { if (owner.closed || owners.get(id) !== owner) throw fault('unsubscribed', 'Commit subscription was released'); return owner; };
      return {
        async prepare(): Promise<WindowLiveCursor> {
          const prepared = active().after; if (prepared) return { ...prepared };
          let current: { sequence: number } | null;
          try { current = tap ? await Promise.race([tap.resample(), owner.released.promise]) : { sequence: 0 }; }
          catch (error) { const failure = fault('live_source_gap', String(error)); fail(owner, failure); throw failure; }
          active(); if (owner.after) return { ...owner.after };
          if (!current) { const failure = fault('live_source_gap', 'Committed-event continuity is unavailable'); fail(owner, failure); throw failure; }
          const after = coordinate(current!.sequence);
          owner.journal = createWindowCommitJournal({ epoch: after, onFailed(error) {
            if (owner.closed) return; owner.closed = true; owner.released.resolve(null);
            if (owners.get(id) === owner) owners.delete(id); notify(owner, error);
          } });
          owner.journal.seal(after); owner.after = after; return { ...after };
        },
        authorize() { active(); if (!owner.journal) throw fault('scope_changed', 'History boundary is not prepared'); owner.journal.authorize(); },
        read(after: WindowLiveCursor) { active(); if (!owner.journal) return Promise.reject(fault('scope_changed', 'History boundary is not prepared')); return owner.journal.read(after); },
        ack(through: WindowLiveCursor) { active(); if (!owner.journal) throw fault('scope_changed', 'History boundary is not prepared'); owner.journal.ack(through); },
        close() { if (owner.closed) return; owner.closed = true; owner.released.resolve(null); if (owners.get(id) === owner) owners.delete(id); owner.journal?.close(); },
      };
    },
    invalidate() { if (tap) tap.invalidate(); else invalidated(fault('live_source_gap', 'The committed-event worker changed')); },
    invalidateStore() { storeEpoch = randomUUID(); invalidated(fault('live_store_changed', 'The canonical history store changed')); },
    close() { if (closed) return; closed = true; tap?.close(); for (const owner of [...owners.values()]) {
      owner.closed = true; owner.released.resolve(null); owner.journal?.close();
    } owners.clear(); },
    inspect() { return { owners: owners.size }; },
  };
}
