import { randomUUID } from 'node:crypto';
import { createWindowCommitTap, type WindowCommittedEvent } from './window-commit-tap';
import { createWindowCommitJournal, type WindowLiveCursor, type WindowCommitReference } from './window-commit-journal';
import type { WindowCommitCapture } from './window-commit-write';
import type { WindowCommitReceipt } from './window-commit-receipt';

type Fault = Error & { code: string };
type Journal = ReturnType<typeof createWindowCommitJournal>;
type Owner = { conversationId: string; failed(error: Fault): void; journal?: Journal; after?: WindowLiveCursor; authorized?: boolean; pending: number; closed: boolean; abort: AbortController };
export type WindowCommitProjection = { projectionId: string; validate?(): void };
export type WindowCommitProject = ((receipt:WindowCommitReceipt)=>Promise<WindowCommitProjection>) & {flush?(sessionId?:string):Promise<void>};
const fault = (code: string, message: string): Fault => Object.assign(new Error(message), { code });
const equal = (a: WindowLiveCursor, b: WindowLiveCursor) => a.workerEpoch === b.workerEpoch && a.storeEpoch === b.storeEpoch && a.sequence === b.sequence;

// Each wait must detach its cancellation handler while the lease remains open.
async function untilReleased<T>(owner: Owner, work: Promise<T>): Promise<T | null> {
  const signal = owner.abort.signal, released = Promise.withResolvers<null>();
  const release = () => released.resolve(null);
  if (signal.aborted) release();
  else signal.addEventListener('abort', release, { once: true });
  try { return await Promise.race([work, released.promise]); }
  finally { signal.removeEventListener('abort', release); }
}

/** Main-owned reservations exist even before a worker does. attach must be awaited
 * inside lazyWorker.onSpawned; this module never calls get/start or retains turns. */
export function createWindowCommitRuntime(ports: {
  persist(event: WindowCommittedEvent, capture?: WindowCommitCapture): Promise<void>;
  capture(event: WindowCommittedEvent, cursor: WindowLiveCursor, committed: WindowCommitCapture['committed']): WindowCommitCapture & {
    project?: WindowCommitProject;
  };
  project: WindowCommitProject;
  flush?(sessionId:string):void;
  report(error: unknown): void;
}) {
  const owners = new Map<string, Owner>();
  const pending = new Map<string, number>();
  const publications = new Map<string,Promise<void>>();
  let pendingCount = 0;
  let workerEpoch = randomUUID(), storeEpoch = randomUUID(), closed = false;
  let tap: ReturnType<typeof createWindowCommitTap> | undefined;
  const report = (error: unknown) => { try { ports.report(error); } catch { /* Reporting cannot alter canonical persistence or other owners. */ } };
  const notify = (owner: Owner, error: Fault) => { try { owner.failed(error); } catch (cause) { report(cause); } };
  const releaseOwner = (owner: Owner) => { owner.closed = true; owner.abort.abort(); };
  function fail(owner: Owner, error: Fault) {
    if (owner.closed) return;
    if (owner.journal) owner.journal.fail(error.code, error.message);
    else { releaseOwner(owner); for (const [id, value] of owners) if (value === owner) owners.delete(id); notify(owner, error); }
  }
  function invalidated(error: Fault) {
    workerEpoch = randomUUID();
    for (const owner of [...owners.values()]) fail(owner, error);
  }
  function coordinate(sequence: number): WindowLiveCursor { return { workerEpoch, storeEpoch, sequence }; }
  function dispatch(event: WindowCommittedEvent, raw: { sequence: number } | null) {
    const selected = [...owners.values()].filter(owner => owner.conversationId === event.sessionId);
    const { sessionId, source } = event, referenceId = event.turn.referenceId;
    let capture: ReturnType<typeof ports.capture> | undefined;
    let releaseCapture = () => {};
    if (raw && event.source !== 'replay' && selected.length) {
      const at = Object.freeze(coordinate(raw.sequence));
      for (const owner of selected) if (!owner.journal) fail(owner, fault('scope_changed', 'The session started before its history boundary was prepared'));
      for (const owner of selected) if (!owner.closed && (owner.pending + owner.journal!.inspect().queued >= 64
        || (pending.get(sessionId) ?? 0) >= 64 || pendingCount >= 2048))
        fail(owner, fault('live_buffer_overflow', 'Pending projections and unacknowledged commits exceeded capacity'));
      const recipients = selected.filter(owner => !owner.closed);
      if (recipients.length) {
        for (const owner of recipients) owner.pending++;
        pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1); pendingCount++;
        let released = false;
        const release = () => { if (!released) {
          released = true; for (const owner of recipients) owner.pending--; pendingCount--;
          const remaining = pending.get(sessionId)! - 1;
          if (remaining) pending.set(sessionId, remaining); else pending.delete(sessionId);
        } }; releaseCapture = release;
        try {
          let project = ports.project;
          capture = ports.capture(event, at, async receipt => {
            if (!receipt) return;
            if (receipt.sessionId !== sessionId || receipt.referenceId !== referenceId || !equal(receipt.latestRevisionCursor, at))
              throw fault('live_identity_mismatch', 'The persisted commit does not match its runtime source');
            // Start work before waiting for the previous publication. Attach the
            // rejection handler immediately, even if an older group is slow.
            const prepared = Promise.resolve().then(() => {
              const result=project(receipt);
              if(recipients.some(owner=>owner.closed))void project.flush?.(sessionId).catch(report);
              return result;
            }).then(
              value => ({ ok: true as const,value }), error => ({ ok: false as const,error }));
            const publish = async () => {
            const result = await prepared; if (!result.ok) throw result.error;
            const projection = result.value;
            const values = { referenceId: receipt.referenceId, rowId: receipt.rowId, storedSeq: receipt.storedSeq,
              projectionId: projection.projectionId, latestRevisionCursor: receipt.latestRevisionCursor };
            const entry: WindowCommitReference = source === 'live' && receipt.firstCommitCursor && equal(receipt.firstCommitCursor, at)
              ? { ...values, kind: 'insert', firstCommitCursor: receipt.firstCommitCursor }
              : { ...values, kind: 'update', firstCommitCursor: receipt.firstCommitCursor };
            for (const owner of recipients) if (!owner.closed) {
              projection.validate?.();
              owner.journal!.publish(entry);
            }
            };
            const next = (publications.get(sessionId) ?? Promise.resolve()).then(publish,publish);
            const tail = next.then(() => undefined,() => undefined); publications.set(sessionId,tail);
            try { await next; } finally { if (publications.get(sessionId) === tail) publications.delete(sessionId); }
          });
          const committed = capture.committed;
          capture.committed = async receipt => { try { await committed(receipt); } finally { release(); } };
          project = capture.project ?? project;
        } catch (error) {
          release();
          for (const owner of recipients) fail(owner, fault('live_capture_failed', String(error)));
          report(error);
        }
      }
    }
    const failed = (error: unknown) => {
      for (const owner of selected) fail(owner, fault('live_commit_failed', String(error)));
      report(error);
    };
    try { void ports.persist(event, capture).then(releaseCapture, error => { releaseCapture(); failed(error); }); }
    catch (error) { releaseCapture(); failed(error); }
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
      const owner: Owner = { conversationId, failed, pending: 0, closed: false, abort: new AbortController() }; owners.set(id, owner);
      const active = () => { if (owner.closed || owners.get(id) !== owner) throw fault('unsubscribed', 'Commit subscription was released'); return owner; };
      return {
        async prepare(): Promise<WindowLiveCursor> {
          const prepared = active().after; if (prepared) return { ...prepared };
          let current: { sequence: number } | null;
          try { current = tap ? await untilReleased(owner, tap.resample()) : { sequence: 0 }; }
          catch (error) { const failure = fault('live_source_gap', String(error)); fail(owner, failure); throw failure; }
          active(); if (owner.after) return { ...owner.after };
          if (!current) { const failure = fault('live_source_gap', 'Committed-event continuity is unavailable'); fail(owner, failure); throw failure; }
          const after = coordinate(current!.sequence);
          owner.journal = createWindowCommitJournal({ epoch: after, onFailed(error) {
            if (owner.closed) return; releaseOwner(owner);
            if (owners.get(id) === owner) owners.delete(id); notify(owner, error);
          } });
          owner.journal.seal(after); owner.after = after; return { ...after };
        },
        authorize() { active(); if (!owner.journal) throw fault('scope_changed', 'History boundary is not prepared'); owner.journal.authorize(); owner.authorized = true; },
        sample(applied: WindowLiveCursor): WindowLiveCursor {
          active(); const after = owner.after, raw = tap?.current(), now = coordinate(raw?.sequence ?? 0);
          if (!owner.authorized || !after) throw fault('scope_changed', 'The history window is not authorized');
          if ((tap && !raw) || !Number.isSafeInteger(applied.sequence) || !equal({ ...applied, sequence: now.sequence }, now) || applied.sequence < after.sequence || applied.sequence > now.sequence)
            throw fault('invalid_cursor', 'The applied cursor is outside this live lease');
          return now;
        },
        async wait<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
          active(); const work = Promise.resolve().then(() => { active(); return operation(owner.abort.signal); })
            .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
          const result = await untilReleased(owner, work);
          active(); if (!result) throw fault('unsubscribed', 'Commit subscription was released');
          if (!result.ok) throw result.error; return result.value;
        },
        read(after: WindowLiveCursor) { active(); if (!owner.journal) return Promise.reject(fault('scope_changed', 'History boundary is not prepared')); return owner.journal.read(after); },
        ack(through: WindowLiveCursor) { active(); if (!owner.journal) throw fault('scope_changed', 'History boundary is not prepared'); owner.journal.ack(through); },
        close() { if (owner.closed) return; releaseOwner(owner); if (owners.get(id) === owner) owners.delete(id); owner.journal?.close();
          try{ports.flush?.(conversationId);}catch(error){report(error);}
        },
      };
    },
    invalidate() { if (tap) tap.invalidate(); else invalidated(fault('live_source_gap', 'The committed-event worker changed')); },
    invalidateStore() { storeEpoch = randomUUID(); invalidated(fault('live_store_changed', 'The canonical history store changed')); },
    close() { if (closed) return; closed = true; tap?.close(); for (const owner of [...owners.values()]) {
      releaseOwner(owner); owner.journal?.close();
    } owners.clear(); },
    inspect() { return { owners: owners.size }; },
  };
}
