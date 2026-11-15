import type { ReverseCheckpoint, SourceRange, SourceSnapshot, WindowBudget, WindowByteSource } from './types';

export const REVERSE_INDEX_BLOCK_BYTES = 64 * 1024;

/** Locating is a separate state, never a message identity or an unread receipt. */
export type ReverseIndexStep =
  | { kind: 'scanning'; checkpoint: ReverseCheckpoint }
  | { kind: 'located'; checkpoint: ReverseCheckpoint; range: SourceRange }
  | { kind: 'reset'; reason: 'source_changed' };

function sameSnapshot(snapshot: SourceSnapshot, checkpoint: ReverseCheckpoint): boolean {
  return snapshot.sourceId === checkpoint.sourceId && snapshot.sourceInstance === checkpoint.sourceInstance &&
    snapshot.snapshotRevision === checkpoint.snapshotRevision && snapshot.size === checkpoint.pinnedEnd;
}

/** A caller owns one durable checkpoint per job, and schedules/preempts between steps.
 * Total first-time work is proportional to this record's unknown prefix. For a file
 * containing only that record this is also the file length; no size skips apply.
 */
export async function stepReverseIndex(source: WindowByteSource, checkpoint: ReverseCheckpoint,
  budget: WindowBudget, signal?: AbortSignal): Promise<ReverseIndexStep> {
  signal?.throwIfAborted();
  if (![checkpoint.pinnedEnd, checkpoint.recordEnd, checkpoint.scanBefore].every(Number.isSafeInteger) ||
    checkpoint.scanBefore < 0 || checkpoint.scanBefore > checkpoint.recordEnd || checkpoint.recordEnd > checkpoint.pinnedEnd)
    throw new RangeError('Invalid reverse-index checkpoint');
  if (!sameSnapshot(await source.snapshot(), checkpoint)) return { kind: 'reset', reason: 'source_changed' };
  signal?.throwIfAborted();
  if (checkpoint.scanBefore === 0) return { kind: 'located', checkpoint, range: { start: 0, end: checkpoint.recordEnd } };
  const start = Math.max(0, checkpoint.scanBefore - REVERSE_INDEX_BLOCK_BYTES);
  const length = checkpoint.scanBefore - start;
  let bytes: Uint8Array = new Uint8Array(0), consumed = 0, failed = false, failure: unknown;
  await budget.read('sourceBytes', length, async () => {
    bytes = new Uint8Array(length);
    try {
      while (consumed < length && !signal?.aborted) {
        const count = await source.read(bytes, consumed, length - consumed, start + consumed);
        if (!Number.isSafeInteger(count) || count < 0 || count > length - consumed) throw new RangeError('Invalid source read length');
        if (!count) break;
        consumed += count;
      }
    } catch (error) { failed = true; failure = error; }
    return consumed;
  });
  if (failed) throw failure;
  signal?.throwIfAborted();
  if (consumed !== length || !sameSnapshot(await source.snapshot(), checkpoint)) return { kind: 'reset', reason: 'source_changed' };
  signal?.throwIfAborted();
  const lf = bytes.lastIndexOf(10);
  const next = { ...checkpoint, scanBefore: start };
  if (lf >= 0 || start === 0) return { kind: 'located', checkpoint: next,
    range: { start: lf >= 0 ? start + lf + 1 : 0, end: checkpoint.recordEnd } };
  return { kind: 'scanning', checkpoint: next };
}
