import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowCommitReceipts, type WindowCommitReceipt, type WindowReceiptDatabase } from './window-commit-receipt';
import { readWindowCommitSourceChunk, writeWindowCommitSource } from './window-commit-source';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';

const migration = readFileSync(new URL('../../../drizzle/0048_window_commit_receipts.sql', import.meta.url), 'utf8');
type DiskSqlite = Pick<WindowReceiptDatabase, 'prepare'> & { readonly isOpen: boolean; readonly isTransaction: boolean; exec(sql: string): void; close(): void };
// Use the actual Node SQLite engine without requiring a newer ambient @types/node package.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new(path: string) => DiskSqlite };
const cleanup: { path: string; databases: DiskSqlite[] }[] = [];
const cursor = (sequence: number) => ({ workerEpoch: 'worker', storeEpoch: 'store', sequence });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0)) { for (const db of f.databases) if (db.isOpen) db.close(); await rm(f.path, { recursive: true, force: true }); }
});
function transaction<T>(db: DiskSqlite, write: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = write(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'window-receipt-')), databases: DiskSqlite[] = [];
  cleanup.push({ path, databases });
  const open = () => { const db = new DatabaseSync(join(path, 'local.db')); databases.push(db); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON'); return db; };
  const db = open();
  // The existing canonical table columns are unchanged by this additive migration.
  db.exec(`CREATE TABLE sessions(id text PRIMARY KEY);
    CREATE TABLE session_turns(id text PRIMARY KEY,session_id text NOT NULL REFERENCES sessions(id),seq integer NOT NULL,
      turn_id text NOT NULL,data text NOT NULL,created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
    INSERT INTO sessions(id) VALUES ('s'),('other');`);
  const before = db.prepare('PRAGMA table_info(session_turns)').all(); db.exec(migration);
  expect(db.prepare('PRAGMA table_info(session_turns)').all()).toEqual(before);
  const text = JSON.stringify({ referenceId: 'ref', items: [{ id: 'item', kind: 'message', text: '正文😀'.repeat(18000) }] });
  const binding = { scope: 'c'.repeat(64), sourceLineage: 'd'.repeat(64), decoderVersion: 1 };
  const source = await writeWindowCommitSource(path, binding, text), queries: string[] = [];
  function store(connection = db) {
    const gateway: WindowReceiptDatabase = { get inTransaction() { return connection.isTransaction; },
      prepare(sql) { queries.push(sql); return connection.prepare(sql); } };
    return createWindowCommitReceipts(gateway);
  }
  const receipt: WindowCommitReceipt = { version: 1, sourceId: 'source-3', sessionId: 's', rowId: 's:17', storedSeq: 17,
    referenceId: 'ref', firstCommitCursor: cursor(3), latestRevisionCursor: cursor(3), binding, source };
  const insert = () => db.prepare('INSERT INTO session_turns(id,session_id,seq,turn_id,data) VALUES (?,?,?,?,?)').run('s:17', 's', 17, 'runtime:0', text);
  return { path, db, open, store, receipt, insert, queries, text };
}

describe('canonical row and bounded write-ahead receipt transaction', () => {
  it('rolls both row and receipt back together without treating an orphan source as an ACKable commit', async () => {
    const f = await fixture(), receipts = f.store();
    expect(() => transaction(f.db, () => { f.insert(); receipts.put(f.receipt); throw new Error('before commit'); })).toThrow('before commit');
    expect(f.db.prepare('SELECT id FROM session_turns').all()).toEqual([]);
    expect(receipts.bySource('source-3')).toBeNull();
    expect(() => receipts.put(f.receipt)).toThrow('share the canonical transaction');
    expect((await readWindowCommitSourceChunk(f.path, f.receipt.binding, f.receipt.source, 1, createWindowBudget())).length).toBe(16384);
  });

  it('reopens after the row/receipt commit and reconstructs from a late source chunk without selecting or parsing the canonical JSON row', async () => {
    const f = await fixture(); transaction(f.db, () => { f.insert(); f.store().put(f.receipt); }); f.db.close();
    const reopened = f.open(), receipts = f.store(reopened), parse = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation((text: string) => { if (text.length > 4096) throw new Error('whole canonical JSON read'); return parse(text); });
    f.queries.length = 0;
    const restored = receipts.byRow('s:17')!;
    expect(restored).toEqual(f.receipt);
    const budget = createWindowBudget(), chunk = await readWindowCommitSourceChunk(f.path, restored.binding, restored.source, 5, budget);
    expect(chunk).toEqual(Buffer.from(f.text).subarray(5 * 16384, 6 * 16384));
    expect(budget.counters.indexBytes).toBe(restored.source.stride);
    expect(f.queries.every(query => !/\bdata\b/i.test(query))).toBe(true);
    expect(receipts.byReference('other', 'ref')).toBeNull();
  });

  it('keeps first commit 3 immutable through revision 10 while a delivered old source remains point-addressable', async () => {
    const f = await fixture(), receipts = f.store(); transaction(f.db, () => { f.insert(); receipts.put(f.receipt); });
    const old = receipts.bySource('source-3');
    const revision = { ...f.receipt, sourceId: 'source-10', latestRevisionCursor: cursor(10) };
    transaction(f.db, () => { f.db.prepare('UPDATE session_turns SET data=data WHERE id=?').run('s:17'); receipts.put(revision); });
    expect(receipts.byReference('s', 'ref')).toEqual(revision);
    expect(receipts.bySource('source-3')).toEqual(old);
    const wrong = { ...revision, sourceId: 'source-11', firstCommitCursor: cursor(11), latestRevisionCursor: cursor(11) };
    expect(() => transaction(f.db, () => { f.db.prepare('UPDATE session_turns SET data=? WHERE id=?').run('changed', 's:17'); receipts.put(wrong); })).toThrow('first proof changed');
    expect(receipts.byRow('s:17')).toEqual(revision);
    expect(() => transaction(f.db, () => receipts.put({ ...wrong, firstCommitCursor: { ...cursor(3), workerEpoch: 'other' } }))).toThrow('cursor domains');
  });

  it('invalidates a new projection position when an old writer changes canonical data, preserving the old writer body and immutable historical receipt', async () => {
    const f = await fixture(), receipts = f.store(); transaction(f.db, () => { f.insert(); receipts.put(f.receipt); });
    const oldHash = f.db.prepare('SELECT data FROM session_turns WHERE id=?').get('s:17');
    f.db.prepare('UPDATE session_turns SET data=? WHERE id=?').run('old writer body', 's:17');
    expect(receipts.byReference('s', 'ref')).toBeNull(); expect(receipts.byRow('s:17')).toBeNull();
    expect(receipts.bySource('source-3')).toEqual(f.receipt);
    expect(f.db.prepare('SELECT data FROM session_turns WHERE id=?').get('s:17')).not.toEqual(oldHash);
    expect(f.db.prepare('SELECT data FROM session_turns WHERE id=?').get('s:17')).toEqual({ data: 'old writer body' });
  });

  it('rejects cross-row bindings and oversized receipt bytes at the actual SQL boundary', async () => {
    const f = await fixture(), receipts = f.store(); transaction(f.db, () => f.insert());
    expect(() => transaction(f.db, () => receipts.put({ ...f.receipt, sessionId: 'other' }))).toThrow('row binding');
    expect(() => transaction(f.db, () => receipts.put({ ...f.receipt, storedSeq: 18 }))).toThrow('row binding');
    expect(() => f.db.prepare('INSERT INTO session_window_commit_receipts VALUES(?,?,?,?,?,?)')
      .run('oversized', 's', 's:17', 17, 'ref', 'x'.repeat(4097))).toThrow(/CHECK constraint/);
    const extra = Object.assign({}, f.receipt, { turn: { toJSON() { throw new Error('full turn retained'); } } });
    transaction(f.db, () => receipts.put(extra));
    expect(receipts.byRow('s:17')).not.toHaveProperty('turn');
    f.db.prepare('DELETE FROM session_turns WHERE id=?').run('s:17');
    expect(receipts.bySource('source-3')).toBeNull();
  });

  it('rejects corrupt receipt metadata without attempting full-row repair', async () => {
    const f = await fixture(), receipts = f.store(); transaction(f.db, () => { f.insert(); receipts.put(f.receipt); });
    f.db.prepare('UPDATE session_window_commit_receipts SET receipt=? WHERE source_id=?').run(JSON.stringify({ ...f.receipt, version: 2 }), 'source-3');
    f.queries.length = 0;
    expect(() => receipts.byRow('s:17')).toThrow('Invalid commit receipt');
    expect(f.queries.every(query => !/\bdata\b/i.test(query))).toBe(true);
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('cannot follow a valid foreign source receipt through a corrupted cross-session position', async () => {
    const f = await fixture(), receipts = f.store(); transaction(f.db, () => { f.insert(); receipts.put(f.receipt); });
    const other = { ...f.receipt, sessionId: 'other', rowId: 'other:17', sourceId: 'other-source' };
    transaction(f.db, () => {
      f.db.prepare('INSERT INTO session_turns(id,session_id,seq,turn_id,data) VALUES(?,?,?,?,?)').run(other.rowId, 'other', 17, 'runtime:0', 'other body');
      receipts.put(other);
    });
    f.db.prepare('UPDATE session_window_commit_positions SET source_id=? WHERE row_id=?').run('other-source', 's:17');
    expect(receipts.byRow('s:17')).toBeNull(); expect(receipts.byReference('s', 'ref')).toBeNull();
    expect(receipts.byReference('other', 'ref')).toEqual(other);
  });

  it('keeps same-epoch revisions monotonic and identity fixed even without a first-insert proof', async () => {
    const f = await fixture(), receipts = f.store();
    const current = { ...f.receipt, sourceId: 'source-10', firstCommitCursor: null, latestRevisionCursor: cursor(10) };
    transaction(f.db, () => { f.insert(); receipts.put(current); });
    const revise = (next: WindowCommitReceipt) => transaction(f.db, () => {
      f.db.prepare('UPDATE session_turns SET data=data WHERE id=?').run('s:17'); receipts.put(next);
    });
    expect(() => revise({ ...current, sourceId: 'source-9', latestRevisionCursor: cursor(9) })).toThrow('revision regressed');
    expect(() => revise({ ...current, sourceId: 'wrong-ref', referenceId: 'another', latestRevisionCursor: cursor(11) })).toThrow('first proof changed');
    expect(() => revise({ ...current, sourceId: 'false-first', firstCommitCursor: cursor(3), latestRevisionCursor: cursor(11) })).toThrow('first proof changed');
    expect(receipts.byRow('s:17')).toEqual(current);
    const next = { ...current, sourceId: 'source-11', latestRevisionCursor: cursor(11) }; revise(next);
    expect(receipts.byRow('s:17')).toEqual(next);
  });
});
