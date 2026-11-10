import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { prepareWindowCommitWrite, commitWindowReceipt } from './window-commit-write';
import { createWindowCommitReceipts, type WindowReceiptDatabase } from './window-commit-receipt';
import { recoverWindowCommitIntent } from './window-commit-intent';
import { windowCommitSourcePath } from './window-commit-source';
import { readWindowCommitSourceCatalog as read, writeWindowCommitSourceCatalog as write, windowCommitCatalogPath } from './window-commit-source-catalog';

type Sqlite = Pick<WindowReceiptDatabase, 'prepare'> & { isOpen: boolean; isTransaction: boolean; exec(sql: string): void; close(): void };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new(path: string) => Sqlite };
const owned: { directory: string; db: Sqlite }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of owned.splice(0)) {
  if (f.db.isOpen) f.db.close(); await rm(f.directory, { recursive: true, force: true });
} });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'source-catalog-')), db = new DatabaseSync(join(directory, 'db')); owned.push({ directory, db });
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE sessions(id text PRIMARY KEY);
    CREATE TABLE session_turns(id text PRIMARY KEY,session_id text REFERENCES sessions(id),seq integer);
    INSERT INTO sessions VALUES ('s'); INSERT INTO session_turns VALUES ('s:0','s',0);`);
  db.exec(readFileSync(new URL('../../../drizzle/0048_window_commit_receipts.sql', import.meta.url), 'utf8'));
  const connection: WindowReceiptDatabase = { get inTransaction() { return db.isTransaction; }, prepare: sql => db.prepare(sql) };
  const scope = { directory, scope: 'a'.repeat(64), sessionId: 's' };
  const receipt = await prepareWindowCommitWrite(connection, { sessionId: 's', rowId: 's:0', referenceId: 'ref', storedSeq: 0,
    insert: true, serialized: '{"text":"原件"}', capture: { ...scope, cursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 1 }, committed: async () => {} } });
  if (!receipt) throw new Error('Missing receipt');
  const path = windowCommitCatalogPath(directory, scope.scope, receipt.sourceId);
  const commit = () => { db.exec('BEGIN'); commitWindowReceipt(connection, receipt); db.exec('COMMIT'); };
  return { directory, db, connection, scope, receipt, path, commit };
}

describe('bounded source-version provenance independent of canonical FK lifetime', () => {
  it('rewrites a catalog after an interrupted attempt left only its unpublished temporary', async () => {
    const f = await fixture(); await rm(f.path); await writeFile(`${f.path}.tmp`, 'interrupted');
    await write(f.directory, f.receipt);
    expect(await read(f.directory, f.scope.scope, f.receipt.sourceId, createWindowBudget())).toEqual({ kind: 'hit', receipt: f.receipt });
  });
  it('persists before canonical publication and survives actual receipt cascade without reading any source body', async () => {
    const f = await fixture(), before = createWindowBudget();
    expect(createWindowCommitReceipts(f.connection).bySource(f.receipt.sourceId)).toBeNull();
    expect(await read(f.directory, f.scope.scope, f.receipt.sourceId, before)).toEqual({ kind: 'hit', receipt: f.receipt });
    f.commit(); expect(await recoverWindowCommitIntent(f.connection, f.scope, createWindowBudget())).toBe('retained');
    f.db.prepare('DELETE FROM session_turns WHERE id=?').run('s:0');
    expect(createWindowCommitReceipts(f.connection).bySource(f.receipt.sourceId)).toBeNull();
    const budget = createWindowBudget(); expect(await read(f.directory, f.scope.scope, f.receipt.sourceId, budget)).toEqual({ kind: 'hit', receipt: f.receipt });
    expect(budget.counters.sourceBytes).toBe(0); expect(budget.counters.indexBytes).toBeGreaterThan(0); expect(budget.counters.indexBytes).toBeLessThan(8192);
  });

  it('cleans the exact raw and catalog write set for an uncommitted intent without touching another version', async () => {
    const f = await fixture(); await writeFile(`${f.path}.unrelated`, 'preserve');
    expect(await recoverWindowCommitIntent(f.connection, f.scope, createWindowBudget())).toBe('removed');
    expect(await read(f.directory, f.scope.scope, f.receipt.sourceId, createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'not_found' });
    await expect(open(windowCommitSourcePath(f.directory, f.receipt.binding))).rejects.toMatchObject({ code: 'ENOENT' });
    const file = await open(`${f.path}.unrelated`); await file.close();
  });

  it('keeps immutable provenance and preserves an unfinished intent when a committed catalog is damaged', async () => {
    const f = await fixture(); f.commit(); await expect(write(f.directory, f.receipt)).rejects.toMatchObject({ code: 'EEXIST' });
    await writeFile(f.path, 'broken');
    await expect(recoverWindowCommitIntent(f.connection, f.scope, createWindowBudget())).rejects.toThrow('catalog');
    await expect(recoverWindowCommitIntent(f.connection, f.scope, createWindowBudget())).rejects.toThrow('catalog');
    const file = await open(windowCommitSourcePath(f.directory, f.receipt.binding)); await file.close();
  });

  it('charges a partial metadata read on cancellation and closes the real file handle', async () => {
    const f = await fixture(), handle = await open(f.path), proto = Object.getPrototypeOf(handle) as FileHandle, original = proto.read;
    await handle.close(); const abort = new AbortController(), handles: FileHandle[] = [];
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
      handles.push(this); const result = await Reflect.apply(original, this, [target, offset, Math.min(17, length), position]); abort.abort(); return result;
    }) as typeof original);
    const budget = createWindowBudget(); await expect(read(f.directory, f.scope.scope, f.receipt.sourceId, budget, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(budget.counters.indexBytes).toBe(17); await expect(handles[0].stat()).rejects.toMatchObject({ code: 'EBADF' });
  });
});
