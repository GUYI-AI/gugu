import Database from 'better-sqlite3';
import { openPhysicalDatabase } from '../../db/physical-connection';
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openWindowProjectionGateway } from './window-projection-gateway';

describe('physical canonical DB projection gateway', () => {
  let directory: string, connection: Database.Database;
  const gateways: ReturnType<typeof openWindowProjectionGateway>[] = [];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'projection-gateway-'));
    connection = openPhysicalDatabase(join(directory, 'canonical.sqlite'));
    connection.exec('CREATE TABLE actual_rows(id TEXT PRIMARY KEY)');
    mkdirSync(join(directory, 'cache-a')); mkdirSync(join(directory, 'cache-b'));
  });
  afterEach(async () => { for (const value of gateways.splice(0)) await value.close(); connection.close(); rmSync(directory, { recursive: true, force: true }); });
  function open(db = connection, cache = 'cache-a') {
    const value = openWindowProjectionGateway(db, join(directory, cache), join(directory, 'global-guards'));
    gateways.push(value); return value;
  }
  it('excludes another profile/cache and real DB aliases, without locking canonical writes', async () => {
    const first = open(); first.proof.assertHeld();
    connection.prepare('INSERT INTO actual_rows VALUES (?)').run('still-writable');
    expect(() => open(connection, 'cache-b')).toThrow('gateway');
    for (const alias of ['symbolic.sqlite', 'hard.sqlite']) {
      if (alias === 'symbolic.sqlite') symlinkSync(connection.name, join(directory, alias));
      else linkSync(connection.name, join(directory, alias));
      const other = openPhysicalDatabase(join(directory, alias));
      try { expect(() => open(other, 'cache-b')).toThrow('gateway'); } finally { other.close(); }
    }
    await first.close(); const next = open(connection, 'cache-b'); next.proof.assertHeld();
    expect(next.proof.namespace).not.toBe(first.proof.namespace);
  });
  it('keeps the kernel guard until an admitted read ends while rejecting new reads', async () => {
    const gate = Promise.withResolvers<void>(), first = open();
    const read = first.run(async () => { await gate.promise; return 'actual completion'; });
    const closing = first.close();
    await expect(first.run(async () => 'late')).rejects.toMatchObject({ code: 'needs_location' });
    expect(() => open()).toThrow('gateway'); gate.resolve();
    await expect(read).resolves.toBe('actual completion'); await closing;
    expect(() => first.proof.assertHeld()).toThrow('gateway'); open().proof.assertHeld();
  });
  it('permanently invalidates an in-flight read after actual cache identity replacement', async () => {
    const first = open(), gate = Promise.withResolvers<void>();
    const read = first.run(async () => { await gate.promise; return 'stale'; });
    const rejected = expect(read).rejects.toMatchObject({ code: 'needs_location' });
    renameSync(join(directory, 'cache-a'), join(directory, 'retired-cache')); mkdirSync(join(directory, 'cache-a'));
    gate.resolve(); await rejected;
    rmSync(join(directory, 'cache-a'), { recursive: true }); renameSync(join(directory, 'retired-cache'), join(directory, 'cache-a'));
    expect(() => first.proof.assertHeld()).toThrow('gateway');
  });
  it('rejects a DB path replaced after connection open but before the first gateway', () => {
    renameSync(connection.name, join(directory, 'retired.sqlite'));
    const replacement = new Database(connection.name); replacement.close();
    expect(connection.prepare('SELECT COUNT(*) AS count FROM actual_rows').get()).toEqual({ count: 0 });
    expect(() => open()).toThrow('gateway');
  });
  it('refuses a replaced DB path even while the original connection remains open', () => {
    const first = open(); renameSync(connection.name, join(directory, 'retired.sqlite'));
    const replacement = new Database(connection.name); replacement.close();
    expect(() => first.proof.assertHeld()).toThrow('gateway');
    expect(connection.open).toBe(true);
    expect(connection.prepare('SELECT COUNT(*) AS count FROM actual_rows').get()).toEqual({ count: 0 });
  });
});
