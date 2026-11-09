import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as files from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { prepareWindowCommitWrite, commitWindowReceipt } from './window-commit-write';
import { createWindowCommitReceipts, type WindowReceiptDatabase } from './window-commit-receipt';
import { recoverWindowCommitIntent } from './window-commit-intent';
import { openWindowCommitPins } from './window-commit-pins';
import { openWindowCommitCollector } from './window-commit-gc';
import { openWindowCommitGc } from './window-commit-gc-discovery';
import { windowCommitSourcePath } from './window-commit-source';
import { windowCommitCatalogPath } from './window-commit-source-catalog';
import { windowCommitProjectionDirectory, writeWindowFrame } from './window-commit-projection-disk';

type Sqlite = Pick<WindowReceiptDatabase, 'prepare'> & { isOpen: boolean; isTransaction: boolean; exec(sql: string): void; close(): void };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new(path: string) => Sqlite };
async function afterCatalogSync(path: string, callback: () => void) {
  const file = await files.open(dirname(path)), identity = await file.stat({ bigint: true });
  const proto = Object.getPrototypeOf(file) as files.FileHandle, sync = proto.sync; await file.close();
  vi.spyOn(proto, 'sync').mockImplementation(async function(this: files.FileHandle) {
    await Reflect.apply(sync, this, []); const current = await this.stat({ bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino && !await exists(path)) callback();
  });
}
function restore() { vi.restoreAllMocks(); }
const owned: { directory: string; db: Sqlite }[] = [];
afterEach(async () => { restore(); for (const f of owned.splice(0)) {
  if (f.db.isOpen) f.db.close(); await files.rm(f.directory, { recursive: true, force: true });
} });
async function fixture() {
  const directory = await files.mkdtemp(join(tmpdir(), 'commit-gc-')), db = new DatabaseSync(join(directory, 'db')); owned.push({ directory, db });
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE sessions(id text PRIMARY KEY);
    CREATE TABLE session_turns(id text PRIMARY KEY,session_id text REFERENCES sessions(id),seq integer);
    INSERT INTO sessions VALUES ('s'); INSERT INTO session_turns VALUES ('s:0','s',0);`);
  db.exec(readFileSync(new URL('../../../drizzle/0048_window_commit_receipts.sql', import.meta.url), 'utf8'));
  const connection: WindowReceiptDatabase = { get inTransaction() { return db.isTransaction; }, prepare: sql => db.prepare(sql) };
  const scope = { directory, scope: 'a'.repeat(64), sessionId: 's' }, receipts = createWindowCommitReceipts(connection);
  let sequence = 0, held = true, protectedIntent = false;
  async function version() {
    const receipt = await prepareWindowCommitWrite(connection, { sessionId: 's', rowId: 's:0', referenceId: 'ref', storedSeq: 0,
      insert: sequence === 0, serialized: JSON.stringify({ text: `version ${sequence}` }),
      capture: { ...scope, cursor: { workerEpoch: 'w', storeEpoch: 's', sequence: ++sequence }, committed: async () => {} } });
    if (!receipt) throw new Error('Missing receipt');
    db.exec('BEGIN'); commitWindowReceipt(connection, receipt); db.exec('COMMIT');
    await recoverWindowCommitIntent(connection, scope, createWindowBudget()); return receipt;
  }
  const proof = { namespace: directory, assertHeld() { if (!held) throw new Error('Lock lost'); } };
  const pins = await openWindowCommitPins({ directory, proof, receipts, async canCollect() { return !protectedIntent; } });
  const collector = await openWindowCommitCollector({ ...scope, pins, connection });
  return { directory, db, connection, scope, receipts, version, pins, collector, proof,
    setLock: (value: boolean) => { held = value; }, protect: (value: boolean) => { protectedIntent = value; } };
}
const exists = async (path: string) => files.stat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false; throw error;
});

describe('bounded version reclamation with durable final cleanup', () => {
  it('does not unlink a replacement at the original path when its receipt physical identity no longer matches', async () => {
    const f = await fixture(), old = await f.version(); await f.version();
    await writeWindowFrame(f.directory, { ...old.binding, kind: 'locator', cursor: 'keep-until-proved' }, new Uint8Array([1]));
    const source = windowCommitSourcePath(f.directory, old.binding); await files.writeFile(source, 'replacement');
    await expect(f.collector.step(old.sourceId, createWindowBudget())).rejects.toThrow('Immutable commit source changed');
    expect(await files.readFile(source, 'utf8')).toBe('replacement');
    expect(await exists(windowCommitProjectionDirectory(f.directory, old.binding))).toBe(true);
    expect(f.receipts.bySource(old.sourceId)).not.toBeNull();
  });

  it('rechecks the physical identity after asynchronous projection deletion before unlinking the raw path', async () => {
    const f = await fixture(), old = await f.version(); await f.version();
    await writeWindowFrame(f.directory, { ...old.binding, kind: 'locator', cursor: 'before-replacement' }, new Uint8Array([1]));
    const path = windowCommitProjectionDirectory(f.directory, old.binding), raw = windowCommitSourcePath(f.directory, old.binding);
    const handle = await files.open(path), identity = await handle.stat({ bigint: true });
    const proto = Object.getPrototypeOf(handle) as files.FileHandle, sync = proto.sync; await handle.close();
    vi.spyOn(proto, 'sync').mockImplementation(async function(this: files.FileHandle) {
      await Reflect.apply(sync, this, []); const current = await this.stat({ bigint: true });
      if (current.dev === identity.dev && current.ino === identity.ino) await files.writeFile(raw, 'late replacement');
    });
    // Deletion is time-sliced; a slow batch returns progress before the raw path.
    const collect = async () => { for (;;) { const step = await f.collector.step(old.sourceId, createWindowBudget()); if (step.kind !== 'progress') return step; } };
    await expect(collect()).rejects.toThrow('Immutable commit source changed');
    expect(await files.readFile(raw, 'utf8')).toBe('late replacement'); expect(f.receipts.bySource(old.sourceId)).not.toBeNull();
  });

  it('runs actual catalog discovery and collection under one budget, then revisits newly retired versions on a later pass', async () => {
    const f = await fixture(), old = await f.version(), latest = await f.version();
    const gc = await openWindowCommitGc({ ...f.scope, pins: f.pins, connection: f.connection });
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 20; i++) {
        const budget = createWindowBudget(), result = await gc.run(budget);
        expect(budget.counters.sourceBytes).toBe(0); expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536);
        if (result.kind === 'end') break;
        if (i === 19) throw new Error('Fixture pass did not finish');
      }
      if (!pass) {
        expect(await exists(windowCommitSourcePath(f.directory, old.binding))).toBe(false);
        expect(await exists(windowCommitSourcePath(f.directory, latest.binding))).toBe(true); await f.version();
      }
    }
    expect(await exists(windowCommitSourcePath(f.directory, latest.binding))).toBe(false); await gc.close();
    await expect(gc.run(createWindowBudget())).rejects.toThrow('closed');
  });

  it('requires both resident releases, protects the current row and recovery intents, and deletes only the retired version', async () => {
    const f = await fixture(), old = await f.version(), latest = await f.version(), owner = {};
    const version = { receipt: old, projectionId: `${old.sourceId}/${'b'.repeat(32)}` };
    const first = await f.pins.acquire(owner, version, createWindowBudget()), second = await f.pins.acquire(owner, version, createWindowBudget());
    expect(await f.collector.step(old.sourceId, createWindowBudget())).toMatchObject({ kind: 'pinned' });
    await first(createWindowBudget()); expect(await f.collector.step(old.sourceId, createWindowBudget())).toMatchObject({ kind: 'pinned' });
    await second(createWindowBudget()); f.protect(true);
    expect(await f.collector.step(old.sourceId, createWindowBudget())).toMatchObject({ kind: 'protected' }); f.protect(false);
    const budget = createWindowBudget(); expect(await f.collector.step(old.sourceId, budget)).toMatchObject({ kind: 'collected' });
    expect(budget.counters.sourceBytes).toBe(0); expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536);
    expect(await exists(windowCommitSourcePath(f.directory, old.binding))).toBe(false);
    expect(await exists(windowCommitCatalogPath(f.directory, old.binding.scope, old.sourceId))).toBe(false);
    expect(f.receipts.bySource(old.sourceId)).toBeNull();
    expect(await exists(windowCommitSourcePath(f.directory, latest.binding))).toBe(true);
    expect(await f.collector.step(latest.sourceId, createWindowBudget())).toMatchObject({ kind: 'current' });
    expect(await f.collector.step(undefined, createWindowBudget())).toEqual({ kind: 'idle' });
  });

  it('resumes a real bounded partial directory deletion through a new gateway without rescanning bodies', async () => {
    const f = await fixture(), old = await f.version(); await f.version();
    for (let i = 0; i < 70; i++) await writeWindowFrame(f.directory, { ...old.binding, kind: 'locator', cursor: `test:${i}` }, new Uint8Array([i]));
    const directory = windowCommitProjectionDirectory(f.directory, old.binding);
    const before = await files.readdir(directory), budget = createWindowBudget();
    expect(await f.collector.step(old.sourceId, budget)).toMatchObject({ kind: 'progress' });
    const remaining = await files.readdir(directory);
    expect(before.length - remaining.length).toBeGreaterThan(0); expect(before.length - remaining.length).toBeLessThanOrEqual(64);
    expect(await exists(windowCommitSourcePath(f.directory, old.binding))).toBe(true);
    await expect(f.pins.acquire({}, { receipt: old, projectionId: `${old.sourceId}/${'b'.repeat(32)}` }, createWindowBudget()))
      .rejects.toMatchObject({ code: 'version_collecting' });
    const pins = await openWindowCommitPins({ directory: f.directory, proof: f.proof, receipts: f.receipts, canCollect: async () => true });
    const restarted = await openWindowCommitCollector({ ...f.scope, pins, connection: f.connection });
    for (let i = 0; i < 100; i++) {
      const b = createWindowBudget(), result = await restarted.step(undefined, b);
      expect(b.counters.sourceBytes).toBe(0); expect(b.counters.indexBytes).toBeLessThanOrEqual(65536);
      if (result.kind === 'collected') break;
      expect(result.kind).toBe('progress'); if (i === 99) throw new Error('Fixture did not finish');
    }
    expect(await exists(directory)).toBe(false); expect(await exists(windowCommitSourcePath(f.directory, old.binding))).toBe(false);
  });

  it('finishes the exact final cleanup after cancellation following the actual catalog unlink', async () => {
    const f = await fixture(), old = await f.version(); await f.version(); const abort = new AbortController();
    const path = windowCommitCatalogPath(f.directory, old.binding.scope, old.sourceId);
    await afterCatalogSync(path, () => abort.abort());
    await expect(f.collector.step(old.sourceId, createWindowBudget(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    restore(); expect(await exists(path)).toBe(false);
    expect(await f.collector.step(undefined, createWindowBudget())).toMatchObject({ kind: 'collected', sourceId: old.sourceId });
    expect(await f.collector.step(undefined, createWindowBudget())).toEqual({ kind: 'idle' });
    const pin = windowFrameName({ ...old.binding, kind: 'head', cursor: `version:pin:${old.sourceId}` });
    expect(await exists(join(f.directory, pin))).toBe(false);
  });

  it('keeps raw provenance after canonical FK deletion and refuses lock loss before deleting artifacts', async () => {
    const f = await fixture(), old = await f.version(); f.db.prepare('DELETE FROM session_turns WHERE id=?').run('s:0');
    expect(f.receipts.bySource(old.sourceId)).toBeNull(); f.setLock(false);
    await expect(f.collector.step(old.sourceId, createWindowBudget())).rejects.toThrow('Lock lost');
    expect(await exists(windowCommitSourcePath(f.directory, old.binding))).toBe(true); f.setLock(true);
    const pins = await openWindowCommitPins({ directory: f.directory, proof: f.proof, receipts: f.receipts, canCollect: async () => true });
    const restarted = await openWindowCommitCollector({ ...f.scope, pins, connection: f.connection });
    expect(await restarted.step(old.sourceId, createWindowBudget())).toMatchObject({ kind: 'collected' });
  });

  it('binds the final cleanup checkpoint to its positive namespace proof', async () => {
    const f = await fixture(), old = await f.version(); await f.version(); const abort = new AbortController();
    const path = windowCommitCatalogPath(f.directory, old.binding.scope, old.sourceId);
    await afterCatalogSync(path, () => abort.abort());
    await expect(f.collector.step(old.sourceId, createWindowBudget(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    restore();
    const foreign = await openWindowCommitPins({ directory: f.directory, proof: { ...f.proof, namespace: 'different database/cache' },
      receipts: f.receipts, canCollect: async () => true });
    const collector = await openWindowCommitCollector({ ...f.scope, pins: foreign, connection: f.connection });
    await expect(collector.step(undefined, createWindowBudget())).rejects.toThrow('checkpoint binding');
    expect(await f.collector.step(undefined, createWindowBudget())).toMatchObject({ kind: 'collected' });
  });

  it('rechecks the proof after the real catalog directory sync before clearing its final checkpoint', async () => {
    const f = await fixture(), old = await f.version(); await f.version();
    const path = windowCommitCatalogPath(f.directory, old.binding.scope, old.sourceId);
    await afterCatalogSync(path, () => f.setLock(false));
    await expect(f.collector.step(old.sourceId, createWindowBudget())).rejects.toMatchObject({ code: 'gateway_invalidated' });
    expect(await exists(path)).toBe(false); restore(); f.setLock(true);
    const pins = await openWindowCommitPins({ directory: f.directory, proof: f.proof, receipts: f.receipts, canCollect: async () => true });
    const restarted = await openWindowCommitCollector({ ...f.scope, pins, connection: f.connection });
    expect(await restarted.step(undefined, createWindowBudget())).toMatchObject({ kind: 'collected' });
  });
});
