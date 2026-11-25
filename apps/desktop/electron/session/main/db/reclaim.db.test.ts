import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { setImmediate } from 'node:timers/promises';
import { beginDatabaseMaintenance, withDatabaseActivity } from './maintenance-activity';
import type { HostIpc, HostIpcInvokeEvent, HostIpcMain } from '../lib/host-ipc';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openPhysicalDatabase, physicalDatabaseBinding } from './physical-connection';
import { applyMigrations, initializeDatabase } from './initialize';
import { databaseSpace, takeDatabaseSpaceChanges } from './space';
import { reclaimDatabase, RECLAIM_PAGE_LIMIT } from './reclaim';
import { maintainDatabases } from './maintenance-worker';
import { openSessionIndex, sessionIndexPath } from '../core/session-index/store';

let directory: string;
const connections: Database.Database[] = [];
const track = (connection: Database.Database) => { connections.push(connection); return connection; };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'sqlite-reclaim-')); });
afterEach(() => {
  for (const connection of connections.splice(0)) if (connection.open) connection.close();
  rmSync(directory, { force: true, recursive: true });
});
function populated(mode: 'new' | 'legacy' = 'new') {
  const path = join(directory, `main-${connections.length}.sqlite`);
  const connection = track(mode === 'new' ? openPhysicalDatabase(path) : new Database(path));
  connection.pragma('journal_mode = WAL');
  connection.exec('CREATE TABLE keep (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO keep VALUES (17, \'preserved\'); CREATE TABLE bulk (data BLOB)');
  const insert = connection.prepare('INSERT INTO bulk VALUES (zeroblob(16384))');
  connection.transaction(() => { for (let i = 0; i < 512; i++) insert.run(); })();
  connection.pragma('wal_checkpoint(TRUNCATE)');
  return connection;
}

it('enables pointer maps before schema creation in both new databases and leaves existing NONE files unchanged', async () => {
  const main = track(openPhysicalDatabase(join(directory, 'fresh.sqlite')));
  expect(main.pragma('auto_vacuum', { simple: true })).toBe(2);
  await initializeDatabase(main);
  const index = track(openSessionIndex(main.name));
  expect(index.pragma('auto_vacuum', { simple: true })).toBe(2);
  index.close();
  expect(track(openSessionIndex(main.name)).pragma('auto_vacuum', { simple: true })).toBe(2);
  const legacy = populated('legacy');
  legacy.close();
  const reopened = track(openPhysicalDatabase(legacy.name));
  expect(reopened.pragma('auto_vacuum', { simple: true })).toBe(0);
  expect(reopened.prepare('SELECT * FROM keep').get()).toEqual({ id: 17, text: 'preserved' });
  // A preexisting search database must also keep its mode and contents.
  const oldIndex = track(new Database(sessionIndexPath(legacy.name)));
  oldIndex.exec('CREATE TABLE retained (data TEXT); INSERT INTO retained VALUES (\'old index\')');
  oldIndex.pragma('user_version = 1');
  oldIndex.close();
  const reopenedIndex = track(openSessionIndex(legacy.name));
  expect(reopenedIndex.pragma('auto_vacuum', { simple: true })).toBe(0);
  expect(reopenedIndex.prepare('SELECT * FROM retained').get()).toEqual({ data: 'old index' });
});

it('records committed DROP and index rebuild page counts without reclaiming during initialization', async () => {
  const connection = populated();
  applyMigrations(connection, []);
  const before = databaseSpace(connection);
  applyMigrations(connection, [{ tag: 'drop-bulk', when: 1, sql: 'DROP TABLE bulk' }]);
  const changes = takeDatabaseSpaceChanges(connection);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ reason: 'drop-bulk', before: { pageCount: before.pageCount } });
  expect(changes[0].after.freelistCount).toBeGreaterThan(2000);
  expect(databaseSpace(connection).pageCount).toBeGreaterThanOrEqual(before.pageCount);
  const fresh = track(openPhysicalDatabase(join(directory, 'indexes.sqlite')));
  await initializeDatabase(fresh);
  expect(takeDatabaseSpaceChanges(fresh).map(change => change.reason)).toEqual(expect.arrayContaining(['search-index rebuild', 'file-index rebuild']));
  await initializeDatabase(fresh);
  expect(takeDatabaseSpaceChanges(fresh)).toEqual([]);
});

it('does not enqueue rolled-back migrations', () => {
  const connection = populated();
  expect(() => applyMigrations(connection, [{ tag: 'failed', when: 1, sql: 'DROP TABLE bulk; SELECT * FROM nonexistent' }])).toThrow();
  expect(takeDatabaseSpaceChanges(connection)).toEqual([]);
  expect(connection.prepare('SELECT count(*) FROM bulk').pluck().get()).toBe(512);
});

it('reclaims in bounded slices, preserves rows and recovers its queue from the freelist after reopening', async () => {
  let connection = populated();
  const binding = physicalDatabaseBinding(connection);
  const originalSize = statSync(connection.name).size;
  connection.exec('DROP TABLE bulk');
  const first = await reclaimDatabase(connection, () => false, { minimumBytes: 1, now: () => 0 });
  expect(first.reclaimedPages).toBe(RECLAIM_PAGE_LIMIT);
  expect(first.after.pageCount).toBeLessThan(first.before.pageCount);
  connection.close();
  connection = track(openPhysicalDatabase(binding.path));
  for (let i = 0; i < 25 && databaseSpace(connection).freelistCount > 10; i++) {
    await reclaimDatabase(connection, () => false, { minimumBytes: 1, now: () => 0 });
  }
  connection.pragma('wal_checkpoint(TRUNCATE)');
  expect(statSync(connection.name).size).toBeLessThan(originalSize / 10);
  expect(connection.prepare('SELECT * FROM keep').get()).toEqual({ id: 17, text: 'preserved' });
  expect(connection.pragma('integrity_check', { simple: true })).toBe('ok');
});

it('yields to new work between pages and never waits for an active writer', async () => {
  const connection = populated();
  connection.exec('DROP TABLE bulk');
  let cancelled = false;
  const result = await reclaimDatabase(connection, () => cancelled, {
    minimumBytes: 1, now: () => 0, yield: async () => { cancelled = true; },
  });
  expect(result).toMatchObject({ state: 'cancelled', reclaimedPages: 1 });
  const writer = track(new Database(connection.name));
  writer.exec('BEGIN IMMEDIATE; INSERT INTO keep VALUES (18, \'concurrent writer\')');
  const busy = await reclaimDatabase(connection, () => false, { minimumBytes: 1, now: () => 0 });
  expect(busy).toMatchObject({ state: 'busy', reclaimedPages: 0 });
  writer.exec('COMMIT');
  expect(connection.prepare('SELECT count(*) FROM keep').pluck().get()).toBe(2);
});

it('respects the time budget and skips legacy/insufficient-space databases', async () => {
  const connection = populated();
  connection.exec('DROP TABLE bulk');
  const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(11);
  expect((await reclaimDatabase(connection, () => false, { minimumBytes: 1, now })).reclaimedPages).toBe(1);
  expect((await reclaimDatabase(connection, () => false)).state).toBe('below-threshold');
  const legacy = populated('legacy');
  legacy.exec('DROP TABLE bulk');
  const before = databaseSpace(legacy);
  expect((await reclaimDatabase(legacy, () => false, { minimumBytes: 1 })).state).toBe('legacy');
  expect(databaseSpace(legacy)).toEqual(before);
});

it('does not open or create targets after cancellation and rejects a replaced database', async () => {
  const cancellation = new SharedArrayBuffer(4);
  Atomics.store(new Int32Array(cancellation), 0, 1);
  const path = join(directory, 'never-created.sqlite');
  expect(await maintainDatabases({ targets: [{ path, identity: 'missing' }], cancellation })).toEqual([]);
  Atomics.store(new Int32Array(cancellation), 0, 0);
  expect(await maintainDatabases({ targets: [{ path, identity: 'missing' }], cancellation })).toMatchObject([{ error: expect.any(String) }]);
  const connection = populated();
  expect(await maintainDatabases({ targets: [{ path: connection.name, identity: 'replaced' }], cancellation })).toMatchObject([{ error: expect.stringContaining('identity changed') }]);
});

it('keeps the main loop responsive and defers request SQLite writes until a real worker releases its write lock', async () => {
  const connection = track(openPhysicalDatabase(join(directory, 'admission.sqlite')));
  connection.pragma('journal_mode = WAL');
  connection.pragma('busy_timeout = 5000');
  connection.exec('CREATE TABLE kept (value TEXT)');
  const binding = createRequire(import.meta.url).resolve(resolve('apps/desktop/session-tooling/node-deps/node_modules/better-sqlite3'));
  const control = beginDatabaseMaintenance();
  // Hold the native writer lock across a controlled boundary. This represents
  // the one maintenance statement already in flight when a request arrives.
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.binding);
    const db = new Database(workerData.path);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    parentPort.once('message', () => {
      if (Atomics.load(new Int32Array(workerData.cancellation), 0) !== 1) throw Error('Cancellation was not immediate');
      db.exec('ROLLBACK'); db.close(); parentPort.postMessage('closed'); parentPort.close();
    });
  `, { eval: true, execArgv: [], workerData: { path: connection.name, binding, cancellation: control.buffer } });
  try {
    expect(await once(worker, 'message')).toEqual(['locked']);
    let handler!: Parameters<HostIpcMain['handle']>[1];
    const host: HostIpc = {
      ipcMain: { handle: (_channel, listener) => { handler = listener; }, removeHandler() {}, on() {}, removeListener() {} },
      broadcast() {}, createMessageChannel: vi.fn(),
    };
    const admitted = vi.fn(() => connection.prepare('INSERT INTO kept VALUES (?)').run('request'));
    withDatabaseActivity(host).ipcMain.handle('write', admitted);
    const response = handler({} as HostIpcInvokeEvent);
    expect(Atomics.load(new Int32Array(control.buffer), 0)).toBe(1);
    expect(admitted).not.toHaveBeenCalled();
    // The request is pending while the writer still holds its lock, and the
    // main event loop can continue. Calling its synchronous write now would
    // block here for busy_timeout, then fail before the test could release it.
    await setImmediate();
    expect(admitted).not.toHaveBeenCalled();
    const closed = once(worker, 'message');
    worker.postMessage('release');
    expect(await closed).toEqual(['closed']);
    control.release();
    await response;
    expect(admitted).toHaveBeenCalledOnce();
    expect(connection.prepare('SELECT * FROM kept').get()).toEqual({ value: 'request' });
  } finally {
    control.release();
    await worker.terminate();
  }
});
