import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { beginWindowCommitIntent as begin, recoverWindowCommitIntent as recover, windowCommitIntentBinding as binding } from './window-commit-intent';
import { createWindowCommitReceipts, type WindowReceiptDatabase } from './window-commit-receipt';
import { windowCommitSourcePath, writeWindowCommitSource } from './window-commit-source';
import { prepareWindowCommitWrite } from './window-commit-write';

type Sqlite = Pick<WindowReceiptDatabase, 'prepare'> & { isOpen: boolean; isTransaction: boolean; exec(sql: string): void; close(): void };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new(path: string) => Sqlite };
const owned: { directory: string; databases: Sqlite[] }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of owned.splice(0)) {
  for (const db of f.databases) if (db.isOpen) db.close(); await rm(f.directory, { recursive: true, force: true });
} });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'commit-intent-')), databases: Sqlite[] = [];
  owned.push({ directory, databases });
  const connect = () => {
    const db = new DatabaseSync(join(directory, 'db')); databases.push(db);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const connection: WindowReceiptDatabase = { get inTransaction() { return db.isTransaction; }, prepare: sql => db.prepare(sql) };
    return { db, connection };
  };
  const c = connect(); c.db.exec(`CREATE TABLE sessions(id text PRIMARY KEY);
    CREATE TABLE session_turns(id text PRIMARY KEY,session_id text REFERENCES sessions(id),seq integer);
    INSERT INTO sessions VALUES ('s'); INSERT INTO session_turns VALUES ('s:0','s',0);`);
  c.db.exec(readFileSync(new URL('../../../drizzle/0048_window_commit_receipts.sql', import.meta.url), 'utf8'));
  const scope = { directory, scope: 'a'.repeat(64), sessionId: 's' }, sourceId = randomUUID();
  const intent = { version: 1 as const, sourceId, sessionId: 's', rowId: 's:0', referenceId: 'ref', storedSeq: 0 };
  const sourceBinding = binding(scope.scope, sourceId), path = windowCommitSourcePath(directory, sourceBinding);
  const write = () => writeWindowCommitSource(directory, sourceBinding, JSON.stringify({ text: 'body'.repeat(18000) }), undefined, true, sourceId);
  return { ...c, scope, intent, path, sourceBinding, connect, write };
}

describe('source-before-write intent and point recovery', () => {
  it('publishes the intent before the actual writer exposes a durable source, then recovers its failed pre-commit phase', async () => {
    const f = await fixture();
    await expect(prepareWindowCommitWrite(f.connection, { ...f.intent, insert: true, serialized: '{"text":"正文"}',
      capture: { directory: f.scope.directory, scope: f.scope.scope,
        cursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 1 }, committed: async () => {},
        phase() { throw new Error('stopped before canonical commit'); } } })).rejects.toThrow('stopped before canonical');
    const budget = createWindowBudget(); expect(await recover(f.connection, f.scope, budget)).toBe('removed');
    expect((await readdir(f.scope.directory)).filter(name => name.endsWith('.source'))).toEqual([]);
  });

  it('recovers a raw partial after closing the database and removes only the recorded temporary source', async () => {
    const f = await fixture(); await begin(f.scope, f.intent);
    await writeFile(`${f.path}.${f.intent.sourceId}.tmp`, 'partial');
    await writeFile(join(f.scope.directory, 'unrelated.tmp'), 'preserve');
    f.db.close(); const reopened = f.connect(), budget = createWindowBudget();
    expect(await recover(reopened.connection, f.scope, budget)).toBe('removed');
    expect(await readdir(f.scope.directory)).toContain('unrelated.tmp');
    expect((await readdir(f.scope.directory)).some(name => name.includes(f.intent.sourceId))).toBe(false);
    expect(budget.counters.indexBytes).toBeGreaterThan(0); expect(budget.counters.indexBytes).toBeLessThanOrEqual(4096);
    expect(await recover(reopened.connection, f.scope, budget)).toBe('none');
  });

  it('removes an immutable source published before a rolled-back canonical receipt, without scanning bodies', async () => {
    const f = await fixture(); await begin(f.scope, f.intent); const source = await f.write();
    f.db.exec('BEGIN'); createWindowCommitReceipts(f.connection).put({ ...f.intent,
      binding: f.sourceBinding, source, firstCommitCursor: null, latestRevisionCursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 1 } });
    f.db.exec('ROLLBACK'); f.db.close();
    expect(await recover(f.connect().connection, f.scope, createWindowBudget())).toBe('removed');
    await expect(open(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a committed immutable source after restart, charging just one head and reading no canonical JSON', async () => {
    const f = await fixture(); await begin(f.scope, f.intent); const source = await f.write();
    f.db.exec('BEGIN'); createWindowCommitReceipts(f.connection).put({ ...f.intent,
      binding: f.sourceBinding, source, firstCommitCursor: null, latestRevisionCursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 1 } });
    f.db.exec('COMMIT'); f.db.close(); const reopened = f.connect(), queries: string[] = [];
    const connection: WindowReceiptDatabase = { get inTransaction() { return reopened.db.isTransaction; }, prepare(sql) {
      queries.push(sql); return reopened.db.prepare(sql);
    } };
    const budget = createWindowBudget(); expect(await recover(connection, f.scope, budget)).toBe('retained');
    expect(queries.every(sql => !/\bdata\b/.test(sql))).toBe(true);
    expect(budget.counters.sourceBytes).toBe(0); expect(budget.counters.indexBytes).toBeLessThanOrEqual(4096);
    const file = await open(f.path); await file.close();
    expect(await recover(connection, f.scope, budget)).toBe('none');
  });

  it('keeps the intent when canonical binding or physical source validation fails', async () => {
    const f = await fixture(); await begin(f.scope, f.intent); const source = await f.write();
    f.db.exec('BEGIN'); createWindowCommitReceipts(f.connection).put({ ...f.intent,
      binding: f.sourceBinding, source, firstCommitCursor: null, latestRevisionCursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 1 } });
    f.db.exec('COMMIT'); await writeFile(f.path, 'rewrite');
    await expect(recover(f.connection, f.scope, createWindowBudget())).rejects.toThrow('source changed');
    await expect(recover(f.connection, { ...f.scope, sessionId: 'other' }, createWindowBudget())).rejects.toThrow('Invalid');
  });

  it('does not lose recovery work on cancellation or an exhausted shared index budget', async () => {
    const f = await fixture(); await begin(f.scope, f.intent); await f.write();
    const abort = new AbortController(); abort.abort(); const budget = createWindowBudget();
    await expect(recover(f.connection, f.scope, budget, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(budget.counters.indexBytes).toBe(0);
    await budget.read('indexBytes', 65536, async () => 65536);
    await expect(recover(f.connection, f.scope, budget)).rejects.toThrow('budget exhausted');
    const file = await open(f.path); await file.close();
    expect(await recover(f.connection, f.scope, createWindowBudget())).toBe('removed');
  });
});
