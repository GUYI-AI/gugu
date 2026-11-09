import type { WindowLiveCursor } from './window-commit-journal';
import type { WindowCommitSourceManifest, writeWindowCommitSource } from './window-commit-source';

type Scalar = string | number | null;
/** The host passes its existing SQLite gateway connection; this module opens no database. */
export type WindowReceiptDatabase = {
  readonly inTransaction: boolean;
  prepare(sql: string): { get(...values: Scalar[]): unknown; all(...values: Scalar[]): unknown[]; run(...values: Scalar[]): unknown };
};
export type WindowCommitReceipt = {
  version: 1; sourceId: string; sessionId: string; rowId: string; storedSeq: number; referenceId: string;
  firstCommitCursor: WindowLiveCursor | null; latestRevisionCursor: WindowLiveCursor;
  binding: Parameters<typeof writeWindowCommitSource>[1]; source: WindowCommitSourceManifest;
};
const scalar = (value: string, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
function cursor(value: WindowLiveCursor): WindowLiveCursor {
  if (!value || !scalar(value.workerEpoch) || !scalar(value.storeEpoch) || !Number.isSafeInteger(value.sequence) || value.sequence < 0)
    throw new Error('Invalid commit receipt cursor');
  return { workerEpoch: value.workerEpoch, storeEpoch: value.storeEpoch, sequence: value.sequence };
}
function encode(input: WindowCommitReceipt): string {
  if (!input || typeof input !== 'object') throw new Error('Invalid commit receipt');
  const { binding: b, source: s } = input;
  if (!input || input.version !== 1 || ![input.sourceId, input.sessionId, input.rowId, input.referenceId].every(value => scalar(value))
    || !Number.isSafeInteger(input.storedSeq) || input.storedSeq < 0 || !b || !/^[a-f0-9]{64}$/.test(b.scope)
    || !/^[a-f0-9]{64}$/.test(b.sourceLineage) || !Number.isSafeInteger(b.decoderVersion) || b.decoderVersion < 1
    || !s || s.version !== 1 || !Number.isSafeInteger(s.bytes) || s.bytes < 1 || s.chunks !== Math.ceil(s.bytes / 16384)
    || !Number.isSafeInteger(s.stride) || s.stride < 16384 || s.stride > 20480 || !/^[a-f0-9]{64}$/.test(s.sha256)
    || !s.physical || ![s.physical.dev, s.physical.ino, s.physical.mtimeNs, s.physical.ctimeNs].every(value => scalar(value, 40) && /^-?\d+$/.test(value)))
    throw new Error('Invalid commit receipt');
  // Explicitly pick every scalar so an accidental full turn is never encoded or retained.
  const result = JSON.stringify({ version: 1, sourceId: input.sourceId, sessionId: input.sessionId, rowId: input.rowId,
    storedSeq: input.storedSeq, referenceId: input.referenceId, firstCommitCursor: input.firstCommitCursor === null ? null : cursor(input.firstCommitCursor),
    latestRevisionCursor: cursor(input.latestRevisionCursor), binding: { scope: b.scope, sourceLineage: b.sourceLineage, decoderVersion: b.decoderVersion },
    source: { version: 1, bytes: s.bytes, chunks: s.chunks, stride: s.stride, sha256: s.sha256,
      physical: { dev: s.physical.dev, ino: s.physical.ino, mtimeNs: s.physical.mtimeNs, ctimeNs: s.physical.ctimeNs } } });
  if (input.firstCommitCursor && (input.firstCommitCursor.workerEpoch !== input.latestRevisionCursor.workerEpoch
    || input.firstCommitCursor.storeEpoch !== input.latestRevisionCursor.storeEpoch || input.firstCommitCursor.sequence > input.latestRevisionCursor.sequence))
    throw new Error('Commit receipt cursor domains differ');
  if (Buffer.byteLength(result, 'utf8') > 4096) throw new Error('Commit receipt exceeds 4 KiB');
  return result;
}
function decode(row: unknown): WindowCommitReceipt | null {
  if (!row) return null;
  const value = row as { source_id: string; session_id: string; row_id: string; stored_seq: number; reference_id: string; receipt: string };
  if (typeof value.receipt !== 'string' || Buffer.byteLength(value.receipt, 'utf8') > 4096) throw new Error('Invalid stored commit receipt');
  const receipt = JSON.parse(value.receipt) as WindowCommitReceipt;
  const normalized = encode(receipt);
  if (receipt.sourceId !== value.source_id || receipt.sessionId !== value.session_id || receipt.rowId !== value.row_id
    || receipt.storedSeq !== value.stored_seq || receipt.referenceId !== value.reference_id) throw new Error('Commit receipt binding mismatch');
  return JSON.parse(normalized) as WindowCommitReceipt;
}

/** A bounded scalar snapshot for asynchronous projection jobs, never a turn. */
export function snapshotWindowCommitReceipt(input: WindowCommitReceipt): WindowCommitReceipt {
  return JSON.parse(encode(input)) as WindowCommitReceipt;
}

/** Caller inserts/updates the canonical row and calls put in that very same transaction.
 * This is a raw-source receipt, not yet an ACKable projection/reference. */
export function createWindowCommitReceipts(connection: WindowReceiptDatabase) {
  const columns = 'r.source_id,r.session_id,r.row_id,r.stored_seq,r.reference_id,r.receipt';
  const joined = `FROM session_window_commit_positions p JOIN session_window_commit_receipts r ON r.source_id=p.source_id
    AND r.row_id=p.row_id AND r.session_id=p.session_id AND r.reference_id=p.reference_id`;
  const byRow = connection.prepare(`SELECT ${columns} ${joined} WHERE p.row_id=?`);
  return {
    byRow(rowId: string) { if (!scalar(rowId)) throw new Error('Invalid row id'); return decode(byRow.get(rowId)); },
    byReference(sessionId: string, referenceId: string) {
      if (!scalar(sessionId) || !scalar(referenceId)) throw new Error('Invalid reference lookup');
      return decode(connection.prepare(`SELECT ${columns} ${joined} WHERE p.session_id=? AND p.reference_id=?`).get(sessionId, referenceId));
    },
    bySource(sourceId: string) {
      if (!scalar(sourceId)) throw new Error('Invalid source id');
      return decode(connection.prepare(`SELECT ${columns} FROM session_window_commit_receipts r WHERE source_id=?`).get(sourceId));
    },
    put(input: WindowCommitReceipt) {
      if (!connection.inTransaction) throw new Error('Commit receipt must share the canonical transaction');
      const data = encode(input);
      const previous = decode(connection.prepare(`SELECT ${columns} FROM session_window_commit_receipts r
        WHERE r.row_id=? ORDER BY r.rowid DESC LIMIT 1`).get(input.rowId));
      if (previous && (previous.referenceId !== input.referenceId
        || (previous.latestRevisionCursor.workerEpoch === input.latestRevisionCursor.workerEpoch
          && previous.latestRevisionCursor.storeEpoch === input.latestRevisionCursor.storeEpoch
          && (JSON.stringify(previous.firstCommitCursor) !== JSON.stringify(input.firstCommitCursor)
            || previous.latestRevisionCursor.sequence >= input.latestRevisionCursor.sequence))))
        throw new Error('Commit first proof changed or revision regressed');
      const row = connection.prepare('SELECT session_id,seq FROM session_turns WHERE id=?').get(input.rowId) as { session_id: string; seq: number } | undefined;
      if (!row || row.session_id !== input.sessionId || row.seq !== input.storedSeq) throw new Error('Canonical commit row binding mismatch');
      connection.prepare(`INSERT INTO session_window_commit_receipts(source_id,session_id,row_id,stored_seq,reference_id,receipt)
        VALUES (?,?,?,?,?,?)`).run(input.sourceId, input.sessionId, input.rowId, input.storedSeq, input.referenceId, data);
      connection.prepare(`INSERT INTO session_window_commit_positions(row_id,session_id,reference_id,source_id) VALUES (?,?,?,?)
        ON CONFLICT(row_id) DO UPDATE SET session_id=excluded.session_id,reference_id=excluded.reference_id,source_id=excluded.source_id`)
        .run(input.rowId, input.sessionId, input.referenceId, input.sourceId);
    },
  };
}
