import type { WindowLiveCursor, WindowCommitReference, WindowCommitPage } from '@gugu/session-wire/session-window-live';
export type { WindowLiveCursor, WindowCommitReference, WindowCommitPage } from '@gugu/session-wire/session-window-live';
type Fault = Error & { code: string };
const fault = (code: string, message: string): Fault => Object.assign(new Error(message), { code });
const LIMITS = { entries: 64, bytes: 4 * 1024 * 1024, pageEntries: 8, pageBytes: 48 * 1024 };
const id = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const sequence = (value: number) => Number.isSafeInteger(value) && value >= 0;
const sameEpoch = (a: WindowLiveCursor, b: WindowLiveCursor) => a.workerEpoch === b.workerEpoch && a.storeEpoch === b.storeEpoch;
const cursor = (value: WindowLiveCursor) => Object.freeze({ workerEpoch: value.workerEpoch, storeEpoch: value.storeEpoch, sequence: value.sequence });

/** A single owner's small durable references. No turn payload, runtime start,
 * persistence or automatic recovery belongs in this buffer. */
export function createWindowCommitJournal(options: {
  epoch: Omit<WindowLiveCursor, 'sequence'>;
  onFailed(error: Fault): void;
  limits?: Partial<typeof LIMITS>;
}) {
  const limits = { ...LIMITS, ...options.limits };
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > LIMITS[key])
      throw fault('live_invalid_capacity', 'Commit capacity must be positive and cannot exceed the fixed limits');
  }
  const origin = cursor({ ...options.epoch, sequence: 0 });
  if (!id(origin.workerEpoch) || !id(origin.storeEpoch)) throw fault('live_invalid_cursor', 'Invalid commit epoch');
  let cut = origin, head = origin, acked = origin, sealed = false, authorized = false;
  let lastSignature: string | undefined, bytes = 0, terminal: Fault | undefined;
  let queue: { reference: Readonly<WindowCommitReference>; bytes: number }[] = [];
  let delivered: WindowCommitPage | undefined;
  let pending: { promise: Promise<WindowCommitPage>; resolve(page: WindowCommitPage): void; reject(error: Fault): void } | undefined;

  function validate(value: WindowLiveCursor): void {
    if (!value || !sameEpoch(value, origin) || !sequence(value.sequence))
      throw fault('live_invalid_cursor', 'Commit cursor belongs to another epoch');
  }
  function checkOpen(): void { if (terminal) throw terminal; }
  function finish(error: Fault, notify: boolean): void {
    if (terminal) return;
    terminal = error; queue = []; bytes = 0; delivered = undefined; lastSignature = undefined;
    const waiting = pending; pending = undefined; waiting?.reject(error);
    if (notify) options.onFailed(error);
  }
  function flush(): void {
    if (!pending || !sealed || !authorized || !queue.length) return;
    let size = 0;
    const entries: Readonly<WindowCommitReference>[] = [];
    for (const entry of queue) {
      if (entries.length >= limits.pageEntries || size + entry.bytes > limits.pageBytes) break;
      size += entry.bytes; entries.push(entry.reference);
    }
    if (!entries.length) { finish(fault('live_buffer_overflow', 'Commit reference exceeds page capacity'), true); return; }
    delivered = Object.freeze({ entries: Object.freeze(entries), next: entries.at(-1)!.latestRevisionCursor, hasMore: entries.length < queue.length });
    const waiting = pending; pending = undefined; waiting.resolve(delivered);
  }
  function reference(input: WindowCommitReference): Readonly<WindowCommitReference> {
    if (input.firstCommitCursor !== null) validate(input.firstCommitCursor);
    validate(input.latestRevisionCursor);
    if (!id(input.referenceId) || !id(input.projectionId) || !id(input.rowId) || !sequence(input.storedSeq)
      || !['insert', 'update'].includes(input.kind)
      || (input.firstCommitCursor !== null && input.firstCommitCursor.sequence > input.latestRevisionCursor.sequence)
      || (input.kind === 'insert' && (!input.firstCommitCursor || input.firstCommitCursor.sequence !== input.latestRevisionCursor.sequence)))
      throw fault('live_invalid_reference', 'Invalid durable commit reference');
    // Explicitly copy only small scalar fields: an accidental `turn` property
    // must never reach JSON sizing, the retained queue or the RPC result.
    const values = { referenceId: input.referenceId, projectionId: input.projectionId,
      rowId: input.rowId, storedSeq: input.storedSeq, latestRevisionCursor: cursor(input.latestRevisionCursor) };
    return input.kind === 'insert' ? Object.freeze({ ...values, kind: 'insert', firstCommitCursor: cursor(input.firstCommitCursor) })
      : Object.freeze({ ...values, kind: 'update', firstCommitCursor: input.firstCommitCursor === null ? null : cursor(input.firstCommitCursor) });
  }

  return {
    seal(after: WindowLiveCursor): void {
      checkOpen(); validate(after);
      if (sealed) throw fault('live_invalid_cursor', 'Commit boundary was already sealed');
      cut = cursor(after); acked = cut; sealed = true;
      queue = queue.filter(entry => entry.reference.latestRevisionCursor.sequence > cut.sequence);
      bytes = queue.reduce((total, entry) => total + entry.bytes, 0);
      if (head.sequence <= cut.sequence) { head = cut; lastSignature = undefined; }
      flush();
    },
    authorize(): void { checkOpen(); authorized = true; flush(); },
    publish(input: WindowCommitReference): void {
      if (terminal) return;
      try {
        const value = reference(input), next = value.latestRevisionCursor;
        if (sealed && next.sequence <= cut.sequence) return;
        const signature = JSON.stringify(value); // Only the bounded scalar copy above.
        if (next.sequence === head.sequence && signature === lastSignature) return;
        if (next.sequence <= head.sequence) throw fault('live_sequence_regressed', 'Commit references arrived out of order');
        const weight = Buffer.byteLength(signature, 'utf8');
        if (queue.length >= limits.entries || bytes + weight > limits.bytes || weight > limits.pageBytes)
          throw fault('live_buffer_overflow', 'Unacknowledged commit references exceeded capacity');
        queue.push({ reference: value, bytes: weight }); bytes += weight;
        head = cursor(next); lastSignature = signature; flush();
      } catch (error) {
        const cause = error as Partial<Fault>;
        finish(fault(cause.code ?? 'live_invalid_reference', String(cause.message ?? error).slice(0, 2048)), true);
      }
    },
    read(after: WindowLiveCursor): Promise<WindowCommitPage> {
      try {
        checkOpen(); validate(after);
        if (!sealed || after.sequence !== acked.sequence) throw fault('live_invalid_cursor', 'Read must follow the acknowledged boundary');
        if (delivered) return Promise.resolve(delivered);
        if (pending) return pending.promise;
        pending = Promise.withResolvers<WindowCommitPage>();
        const promise = pending.promise; flush(); return promise;
      } catch (error) { return Promise.reject(error); }
    },
    ack(through: WindowLiveCursor): void {
      checkOpen(); validate(through);
      if (!sealed) throw fault('live_invalid_cursor', 'Commit boundary is not sealed');
      if (through.sequence <= acked.sequence) return;
      if (!delivered || through.sequence !== delivered.next.sequence)
        throw fault('live_invalid_cursor', 'ACK must name the delivered page end');
      acked = cursor(through);
      queue = queue.filter(entry => entry.reference.latestRevisionCursor.sequence > through.sequence);
      bytes = queue.reduce((total, entry) => total + entry.bytes, 0); delivered = undefined;
    },
    fail(code: string, message: string): void { finish(fault(code, message.slice(0, 2048)), true); },
    close(): void { finish(fault('unsubscribed', 'Commit subscription was released'), false); },
    inspect() { return { queued: queue.length, bytes, waiting: Boolean(pending), delivered: Boolean(delivered), closed: Boolean(terminal) }; },
  };
}
