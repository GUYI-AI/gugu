import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { createWindowCommitReceipts, type WindowReceiptDatabase, type WindowCommitReceipt } from './window-commit-receipt';

export type HistoricalCommitLocator = { rowId: string; storedSeq: number; receipt: WindowCommitReceipt };
export type CanonicalOlderDependency = { kind: 'canonical_source'; rowId: string; storedSeq: number };
export type CanonicalOlderPage =
  | { kind: 'canonical_end' }
  | { kind: 'needs_location'; dependency: CanonicalOlderDependency; beforeStoredSeq: number | null }
  | { kind: 'page'; records: HistoricalCommitLocator[]; nextBeforeStoredSeq: number; canonicalMore: false | 'unknown'; dependency?: CanonicalOlderDependency };

/** Host-only historical metadata, never live insert/update events or turn JSON.
 * The existing canonical writer owns unique per-session storedSeq ordering.
 * The session/seq index and LIMIT 1 bound each lookup. Missing receipt ownership
 * stops at that row instead of decoding legacy data or advancing past it.
 * decodedBytes conservatively reserves bounded SQLite result metadata; it is
 * not reported as physical source/index I/O. No budget is created here. */
export async function readCanonicalWindowOlder(input: {
  connection: WindowReceiptDatabase; sessionId: string; beforeStoredSeq: number | null; limit: number;
}, budget: WindowBudget, signal?: AbortSignal): Promise<CanonicalOlderPage> {
  if (!input.sessionId || input.sessionId.length > 256 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 8
    || (input.beforeStoredSeq !== null && (!Number.isSafeInteger(input.beforeStoredSeq) || input.beforeStoredSeq < 0)))
    throw new Error('Invalid canonical Older request');
  signal?.throwIfAborted();
  const receipts = createWindowCommitReceipts(input.connection), records: HistoricalCommitLocator[] = [];
  let before = input.beforeStoredSeq;
  for (let count = 0; count < input.limit; count++) {
    signal?.throwIfAborted(); budget.charge('examinedRecords', 1); budget.charge('decodedBytes', 1024);
    const row = (before === null
      ? input.connection.prepare('SELECT id,seq FROM session_turns WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(input.sessionId)
      : input.connection.prepare('SELECT id,seq FROM session_turns WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT 1').get(input.sessionId, before)) as { id: string; seq: number } | undefined;
    if (!row) return records.length ? { kind: 'page', records, nextBeforeStoredSeq: before!, canonicalMore: false } : { kind: 'canonical_end' };
    if (typeof row.id !== 'string' || !row.id.length || row.id.length > 256 || !Number.isSafeInteger(row.seq) || row.seq < 0)
      throw new Error('Invalid canonical Older row');
    signal?.throwIfAborted(); budget.charge('examinedRecords', 1); budget.charge('decodedBytes', 4096);
    const receipt = receipts.byRow(row.id); signal?.throwIfAborted();
    if (!receipt) {
      const dependency: CanonicalOlderDependency = { kind: 'canonical_source', rowId: row.id, storedSeq: row.seq };
      return records.length ? { kind: 'page', records, nextBeforeStoredSeq: before!, canonicalMore: 'unknown', dependency }
        : { kind: 'needs_location', dependency, beforeStoredSeq: input.beforeStoredSeq };
    }
    if (receipt.sessionId !== input.sessionId || receipt.rowId !== row.id || receipt.storedSeq !== row.seq)
      throw new Error('Historical receipt binding mismatch');
    records.push({ rowId: row.id, storedSeq: row.seq, receipt }); before = row.seq;
  }
  return { kind: 'page', records, nextBeforeStoredSeq: before!, canonicalMore: 'unknown' };
}
