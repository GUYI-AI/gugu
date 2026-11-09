import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createWindowBudget, WINDOW_LIMITS } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createWindowCommitReceipts, type WindowReceiptDatabase, type WindowCommitReceipt } from './window-commit-receipt';
import { writeWindowCommitSource } from './window-commit-source';
import { windowCommitIntentBinding } from './window-commit-intent';
import { readCanonicalWindowOlder as read } from './window-older-keyset';

type Sqlite = Pick<WindowReceiptDatabase, 'prepare'> & { isOpen: boolean; isTransaction: boolean; exec(sql: string): void; close(): void };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new(path: string) => Sqlite };
const owned: { directory: string; db: Sqlite }[] = [];
afterEach(async () => { for (const f of owned.splice(0)) { if (f.db.isOpen) f.db.close(); await rm(f.directory, { recursive: true, force: true }); } });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'older-keyset-')), db = new DatabaseSync(join(directory, 'db')); owned.push({ directory, db });
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE sessions(id text PRIMARY KEY);
    CREATE TABLE session_turns(id text PRIMARY KEY,session_id text REFERENCES sessions(id),seq integer,data text,turn_id text);
    CREATE INDEX idx_session_turns_session_seq ON session_turns(session_id,seq);
    INSERT INTO sessions VALUES ('s'),('foreign'); INSERT INTO session_turns VALUES ('foreign:99','foreign',99,'poison',null);`);
  db.exec(readFileSync(new URL('../../../drizzle/0048_window_commit_receipts.sql', import.meta.url), 'utf8'));
  const calls: { sql: string; values: (string | number | null)[] }[] = [];
  const connection: WindowReceiptDatabase = { get inTransaction() { return db.isTransaction; }, prepare(sql) {
    const statement = db.prepare(sql); return { ...statement, get(...values) { calls.push({ sql, values }); return statement.get(...values); },
      all: (...values) => statement.all(...values), run: (...values) => statement.run(...values) };
  } };
  const receipts = createWindowCommitReceipts(connection);
  async function attach(seq: number) {
    const sourceId = randomUUID(), binding = windowCommitIntentBinding('a'.repeat(64), sourceId);
    const source = await writeWindowCommitSource(directory, binding, JSON.stringify({ text: `row ${seq}` }));
    const receipt: WindowCommitReceipt = { version: 1, sourceId, sessionId: 's', rowId: `s:${seq}`, storedSeq: seq, referenceId: `native:${seq}`,
      firstCommitCursor: null, latestRevisionCursor: { workerEpoch: 'w', storeEpoch: 's', sequence: seq + 1 }, binding, source };
    db.exec('BEGIN'); receipts.put(receipt); db.exec('COMMIT'); return receipt;
  }
  for (let seq = 0; seq < 6; seq++) {
    db.prepare('INSERT INTO session_turns VALUES (?,?,?,?,?)').run(`s:${seq}`, 's', seq, 'invalid JSON must never be decoded', null);
    if (seq !== 2) await attach(seq);
  }
  calls.length = 0; return { directory, db, connection, calls, attach };
}
describe('bounded canonical historical receipt keyset', () => {
  it('pages real stored sequences, stops at a missing receipt, then continues after that exact dependency is repaired', async () => {
    const f = await fixture(), request = { connection: f.connection, sessionId: 's', limit: 2 };
    const first = await read({ ...request, beforeStoredSeq: null }, createWindowBudget());
    expect(first).toMatchObject({ kind: 'page', nextBeforeStoredSeq: 4, canonicalMore: 'unknown' });
    if (first.kind !== 'page') throw new Error('Missing page'); expect(first.records.map(r => r.storedSeq)).toEqual([5, 4]);
    expect(first.records.every(r => r.receipt.firstCommitCursor === null)).toBe(true);
    const partial = await read({ ...request, beforeStoredSeq: 4 }, createWindowBudget());
    expect(partial).toMatchObject({ kind: 'page', nextBeforeStoredSeq: 3, dependency: { kind: 'canonical_source', rowId: 's:2' } });
    if (partial.kind !== 'page') throw new Error('Missing page'); expect(partial.records.map(r => r.storedSeq)).toEqual([3]);
    expect(await read({ ...request, beforeStoredSeq: 3 }, createWindowBudget())).toMatchObject({ kind: 'needs_location', beforeStoredSeq: 3, dependency: { storedSeq: 2 } });
    await f.attach(2); const repaired = await read({ ...request, beforeStoredSeq: 3 }, createWindowBudget());
    if (repaired.kind !== 'page') throw new Error('Missing page'); expect(repaired.records.map(r => r.storedSeq)).toEqual([2, 1]);
    expect(await read({ ...request, limit: 8, beforeStoredSeq: 1 }, createWindowBudget())).toMatchObject({ kind: 'page', nextBeforeStoredSeq: 0, canonicalMore: false });
    expect(await read({ ...request, beforeStoredSeq: 0 }, createWindowBudget())).toEqual({ kind: 'canonical_end' });
  });

  it('uses the actual session/seq index, never selects canonical JSON, and reserves metadata before each real point query', async () => {
    const f = await fixture(), budget = createWindowBudget();
    const page = await read({ connection: f.connection, sessionId: 's', beforeStoredSeq: 5, limit: 2 }, budget);
    expect(page.kind).toBe('page'); expect(f.calls).toHaveLength(4);
    expect(budget.counters.examinedRecords).toBe(f.calls.length); expect(budget.counters.decodedBytes).toBe(2 * (1024 + 4096));
    expect(budget.counters.sourceBytes).toBe(0); expect(budget.counters.indexBytes).toBe(0);
    for (const call of f.calls) {
      expect(call.sql).not.toMatch(/\bdata\b|SELECT\s+\*/i);
      if (call.sql.startsWith('SELECT id,seq')) {
        const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.values) as { detail: string }[];
        expect(plan.some(p => /SEARCH.*idx_session_turns_session_seq/.test(p.detail))).toBe(true);
        expect(plan.some(p => /SCAN|TEMP B-TREE/.test(p.detail))).toBe(false);
      }
    }
  });

  it('makes no point query after cancellation or budget admission failure and never advances across legacy ownership', async () => {
    const f = await fixture(), request = { connection: f.connection, sessionId: 's', beforeStoredSeq: 3, limit: 8 };
    const abort = new AbortController(); abort.abort();
    await expect(read(request, createWindowBudget(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(f.calls).toEqual([]);
    await expect(read(request, createWindowBudget({ ...WINDOW_LIMITS, decodedBytes: 0 }))).rejects.toMatchObject({ name: 'WindowBudgetExceeded' }); expect(f.calls).toEqual([]);
    expect(await read(request, createWindowBudget())).toMatchObject({ kind: 'needs_location', beforeStoredSeq: 3, dependency: { rowId: 's:2' } });
  });
});
