import { mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPhysicalDatabase, physicalDatabaseBinding } from './physical-connection';
import Database from 'better-sqlite3';

const state = vi.hoisted(() => ({ beforeOpen: undefined as (() => void) | undefined, afterOpen: undefined as (() => void) | undefined }));
vi.mock('better-sqlite3', async original => {
  const actual = await original<{ default: typeof Database }>();
  return { ...actual, default: new Proxy(actual.default, { construct(target, args) {
    const before = state.beforeOpen; state.beforeOpen = undefined; before?.();
    const value = Reflect.construct(target, args), after = state.afterOpen; state.afterOpen = undefined; after?.(); return value;
  } }) };
});

describe('canonical connection physical open binding', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'physical-db-')); });
  afterEach(() => { state.beforeOpen = state.afterOpen = undefined; rmSync(directory, { recursive: true, force: true }); });
  it('does not adopt an unregistered connection by its current name', () => {
    const connection = new Database(join(directory, 'raw.sqlite'));
    try { expect(() => physicalDatabaseBinding(connection)).toThrow('gateway'); } finally { connection.close(); }
  });
  it('rejects a DB path that names another file once the constructor returns', () => {
    const path = join(directory, 'canonical.sqlite');
    state.afterOpen = () => { renameSync(path, `${path}.old`); writeFileSync(path, ''); };
    expect(() => openPhysicalDatabase(path)).toThrow('gateway');
  });
  it('does not let SQLite create a replacement file when the path vanishes mid-open', () => {
    const path = join(directory, 'canonical.sqlite');
    state.beforeOpen = () => renameSync(path, `${path}.old`);
    expect(() => openPhysicalDatabase(path)).toThrow();
  });
  it('opens the canonical DB while unrelated files in its directory change', () => {
    const path = join(directory, 'canonical.sqlite');
    state.afterOpen = () => { writeFileSync(join(directory, 'Local State'), '{}'); utimesSync(directory, 1, 1); };
    const connection = openPhysicalDatabase(path);
    try { expect(physicalDatabaseBinding(connection).path).toBe(realpathSync(path)); } finally { connection.close(); }
  });
});
