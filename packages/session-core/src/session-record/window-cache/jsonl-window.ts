import { readBytePage } from './byte-page';
import type { BytePageCursor, SourceRange, SourceSnapshot, WindowBudget, WindowByteSource } from './types';

export type JsonlRecordSlice = { range: SourceRange; bytes: Uint8Array };
export type JsonlWindow = {
  kind: 'records' | 'pending_record'; snapshot: SourceSnapshot;
  /** Newest first. Byte ranges exclude the physical CR/LF terminator. */
  records: JsonlRecordSlice[];
  /** The start is unknown; only the locator may turn this into a record identity. */
  headFragment: { recordEnd: number; scanBefore: number } | null;
  older: BytePageCursor | null;
};

/** One physical suffix page, never a loop to EOF or a concatenated partial line. */
export async function readJsonlWindow(source: WindowByteSource, options: {
  budget: WindowBudget; cursor?: BytePageCursor; signal?: AbortSignal; limit?: number;
}): Promise<JsonlWindow | { kind: 'reset'; reason: 'source_changed' }> {
  const limit = options.limit ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new RangeError('Invalid record page limit');
  const page = await readBytePage(source, options);
  if (page.kind === 'reset') return page;
  const records: JsonlRecordSlice[] = [];
  const { bytes, snapshot } = page;
  let end = bytes.length;
  // A terminal LF closes the last record; it is not an empty record at EOF.
  if (end > 0 && bytes[end - 1] === 10) {
    end -= 1;
    if (end > 0 && bytes[end - 1] === 13) end -= 1;
  }
  let before = page.start + end;
  let headFragment: JsonlWindow['headFragment'] = null;
  while (end > 0 && records.length < limit) {
    options.signal?.throwIfAborted();
    let lf = end - 1;
    while (lf >= 0 && bytes[lf] !== 10) lf -= 1;
    if (lf < 0 && page.start !== 0) {
      headFragment = { recordEnd: page.start + end, scanBefore: page.start };
      before = headFragment.recordEnd;
      break;
    }
    const start = lf + 1;
    if (end > start) {
      options.budget.charge('examinedRecords', 1);
      records.push({ range: { start: page.start + start, end: page.start + end }, bytes: bytes.subarray(start, end) });
    }
    before = page.start + start;
    end = Math.max(0, lf);
    if (end > 0 && bytes[end - 1] === 13) end -= 1;
  }
  if (end === 0 && !headFragment) before = page.start;
  options.signal?.throwIfAborted();
  // An unknown start is not a consumable byte-page cursor. E's reverse locator owns
  // continuation from scanBefore; returning before=recordEnd would repeat this page.
  return { kind: headFragment ? 'pending_record' : 'records', snapshot, records, headFragment,
    older: !headFragment && before > 0 ? { sourceId: snapshot.sourceId, sourceInstance: snapshot.sourceInstance,
      snapshotRevision: snapshot.snapshotRevision, before } : null };
}
