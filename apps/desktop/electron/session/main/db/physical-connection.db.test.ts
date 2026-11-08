import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPhysicalDatabase, physicalDatabaseBinding } from './physical-connection';
import Database from 'better-sqlite3';

const state = vi.hoisted(() => ({ afterOpen: undefined as (() => void) | undefined }));
vi.mock('better-sqlite3', async original => {
  const actual = await original<typeof import('better-sqlite3')>();
  return { ...actual, default: new Proxy(actual.default, { construct(target, args) {
    const value = Reflect.construct(target, args), after = state.afterOpen; state.afterOpen = undefined; after?.(); return value;
  } }) };
});

describe('canonical connection physical open binding', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'physical-db-')); });
  afterEach(() => { state.afterOpen = undefined; rmSync(directory, { recursive: true, force: true }); });
  it('does not adopt an unregistered connection by its current name', () => {
    const connection = new Database(join(directory, 'raw.sqlite'));
    try { expect(() => physicalDatabaseBinding(connection)).toThrow('gateway'); } finally { connection.close(); }
  });
  it('rejects a rename away and back inside the actual constructor boundary', () => {
    const path = join(directory, 'canonical.sqlite');
    state.afterOpen = () => { renameSync(path, `${path}.old`); renameSync(`${path}.old`, path); };
    expect(() => openPhysicalDatabase(path)).toThrow('gateway');
  });
});
