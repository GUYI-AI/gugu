import { eventFromUpdate } from '@gugu/session-wire';
import type { EventStreamSnapshotData, LiveSnapshot, LiveUpdate } from '@gugu/session-wire/live';
import type { AttachOptions, EventStreamEvent } from '@gugu/session-wire/api';
import type { AcpRuntimeApiContract } from '@gugu/session-core/acp';

export type RawCommitCursor = Pick<LiveUpdate, 'generation' | 'sequence'>;
export type WindowCommittedEvent = EventStreamEvent<AcpRuntimeApiContract['turnCommitted']>;
type Stream = { snapshot(): Promise<LiveSnapshot<EventStreamSnapshotData>>;
  attach(push: (update: LiveUpdate) => void, options?: AttachOptions): Promise<() => void> };
const raw = (value: RawCommitCursor) => Object.freeze({ generation: value.generation, sequence: value.sequence });
const valid = (value: RawCommitCursor) => Number.isSafeInteger(value.generation) && value.generation >= 0
  && Number.isSafeInteger(value.sequence) && value.sequence >= 0;

/** Install inside lazyWorker.onSpawned, before its awaited start barrier is released.
 * Only actual private stream coordinates are used; no local sequence replaces them.
 * A gap invalidates bounded owners, while ordinary canonical persistence continues. */
export function createWindowCommitTap(options: {
  onCommit(event: WindowCommittedEvent, cursor: Readonly<RawCommitCursor> | null): void;
  onInvalidated(error: Error & { code: string }): void;
  onObservationError?(error: unknown): void;
}) {
  let closed = false, ready = false, invalidated = false, version = 0;
  let current: Readonly<RawCommitCursor> | null = null, last: Readonly<RawCommitCursor> | null = null;
  let stream: Stream | undefined, detach: (() => void) | undefined;
  const closing = Promise.withResolvers<null>();
  let sampling: Promise<Readonly<RawCommitCursor> | null> | undefined;
  function invalidate(message: string) {
    ready = false; current = null; version++;
    if (!invalidated && !closed) {
      invalidated = true;
      try { options.onInvalidated(Object.assign(new Error(message), { code: 'live_source_gap' })); }
      catch (error) { try { options.onObservationError?.(error); } catch { /* Diagnostics cannot interrupt canonical event delivery. */ } }
    }
  }
  function update(value: LiveUpdate) {
    if (closed) return;
    let proof: Readonly<RawCommitCursor> | null = null;
    if (!valid(value) || !Number.isSafeInteger(value.baseSequence) || value.sequence !== value.baseSequence + 1) {
      invalidate('Invalid committed-event source coordinates');
    } else {
      last = raw(value);
      if (ready && current && value.generation === current.generation && value.baseSequence === current.sequence) current = proof = last;
      else invalidate('Committed-event source lost continuity');
    }
    // The existing writer still sees this event once. An unproven cursor never
    // creates a bounded capture context or a reference that could be ACKed.
    options.onCommit(eventFromUpdate<WindowCommittedEvent>(value), proof);
  }
  async function sample(): Promise<Readonly<RawCommitCursor> | null> {
    if (closed || !stream) return null;
    const selected = version, before = last;
    const snapshot = await Promise.race([stream.snapshot(), closing.promise]);
    if (!snapshot) return null;
    if (closed || selected !== version) return null;
    if (!valid(snapshot)) { invalidate('Invalid committed-event source snapshot'); return null; }
    if (last !== before && last && last.generation !== snapshot.generation) {
      invalidate('Committed-event source changed while sampling'); return null;
    }
    // New sampling is only for a new opening after the previous owners failed.
    // It never resumes those old owners or replays their missing payloads.
    const observed = last?.generation === snapshot.generation && last.sequence >= snapshot.sequence ? last : raw(snapshot);
    if ((!last && snapshot.sequence !== 0) || (last?.generation === snapshot.generation && snapshot.sequence > last.sequence))
      invalidate('Committed-event source advanced without a delivered event');
    current = observed; ready = true; invalidated = false;
    return current;
  }
  return {
    async attach(source: Stream) {
      if (stream) throw new Error('Committed-event tap is already attached');
      if (closed) return;
      stream = source;
      const attaching = source.attach(update, { onReattach: () => invalidate('Committed-event source reattached'),
        onReattachError: () => invalidate('Committed-event source transport failed') });
      const release = await Promise.race([attaching, closing.promise]);
      if (!release) { void attaching.then(stop => stop()).catch(() => {}); return; }
      if (closed) { release(); return; }
      detach = release;
      // Metadata failure fails the bounded owners; it must not prevent the
      // existing canonical listener from persisting future runtime events.
      try { await this.resample(); } catch { /* Already reported through onInvalidated. */ }
    },
    /** Explicit metadata-only sampling for a new Prepare; never starts a worker or retries a failed view. */
    resample(): Promise<Readonly<RawCommitCursor> | null> {
      if (closed || ready) return Promise.resolve(this.current());
      if (sampling) return sampling;
      const task = sample().catch(error => { invalidate('Committed-event source snapshot failed'); throw error; }); sampling = task;
      void task.finally(() => { if (sampling === task) sampling = undefined; }).catch(() => {});
      return task;
    },
    current() { return !closed && ready ? current : null; },
    invalidate() { invalidate('Committed-event worker restarted'); },
    close() { if (closed) return; closed = true; ready = false; current = null; version++; closing.resolve(null); detach?.(); detach = undefined; },
  };
}
