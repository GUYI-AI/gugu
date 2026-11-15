import type { BytePageCursor, BytePageResult, WindowBudget, WindowByteSource } from './types';
export type { BytePageCursor, BytePageResult, WindowByteSource, SourceSnapshot } from './types';
export const WINDOW_FRAME_BYTES = 64 * 1024;

/** Returns raw bytes, including partial JSON/UTF-8; decoding owns record framing. */
export async function readBytePage(source: WindowByteSource, options: {
  budget: WindowBudget; cursor?: BytePageCursor; signal?: AbortSignal;
}): Promise<BytePageResult> {
  const { budget, cursor, signal } = options;
  signal?.throwIfAborted();
  const initial = await source.snapshot();
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(initial.size) || initial.size < 0) throw new RangeError('Invalid source size');
  if (cursor && (cursor.sourceId !== initial.sourceId || cursor.sourceInstance !== initial.sourceInstance ||
    cursor.snapshotRevision !== initial.snapshotRevision)) return { kind: 'reset', reason: 'source_changed' };
  const end = cursor?.before ?? initial.size;
  if (!Number.isSafeInteger(end) || end < 0 || end > initial.size) throw new RangeError('Invalid byte-page cursor');
  const start = Math.max(0, end - WINDOW_FRAME_BYTES);
  // The admission callback runs only after the aggregate budget reserves this allocation.
  let bytes: Uint8Array = new Uint8Array(0);
  let consumed = 0;
  let readFailure: unknown;
  let failed = false;
  await budget.read('sourceBytes', end - start, async () => {
    bytes = new Uint8Array(end - start);
    try {
      while (consumed < bytes.length && !signal?.aborted) {
        const count = await source.read(bytes, consumed, bytes.length - consumed, start + consumed);
        if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - consumed) throw new RangeError('Invalid read length');
        if (count === 0) break;
        consumed += count;
      }
    } catch (error) { failed = true; readFailure = error; }
    return consumed;
  });
  if (failed) throw readFailure;
  signal?.throwIfAborted();
  const final = await source.snapshot();
  signal?.throwIfAborted();
  if (consumed !== bytes.length || final.sourceId !== initial.sourceId || final.sourceInstance !== initial.sourceInstance ||
    final.snapshotRevision !== initial.snapshotRevision || final.size !== initial.size) return { kind: 'reset', reason: 'source_changed' };
  return { kind: 'page', snapshot: initial, start, end, bytes,
    older: start > 0 ? { sourceId: initial.sourceId, sourceInstance: initial.sourceInstance,
      snapshotRevision: initial.snapshotRevision, before: start } : null };
}
