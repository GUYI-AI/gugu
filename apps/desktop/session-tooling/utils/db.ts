/**
 * Test utilities for database migration tests.
 *
 * Uses our own initializeDatabase() (same code path as the production app)
 * so any bugs in the migration runner itself are caught by the test suite.
 *
 * better-sqlite3 is resolved via the Vitest alias to tooling/node-deps/,
 * an isolated copy compiled for system Node. The root node_modules copy
 * stays Electron-compiled at all times — no rebuild switching needed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openPhysicalDatabase } from '@main/db/physical-connection';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { applyMigrations, bundledMigrations, initializeDatabase } from '@main/db/initialize';
import * as schema from '@main/db/schema';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));

export type FixtureDb = {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
  /** Close the database and delete the temporary copy. */
  close: () => void;
};

/**
 * Opens a named fixture database as an isolated writable copy, applies any
 * pending migrations using our own initializeDatabase(), and returns a ready
 * DrizzleClient.
 *
 * Each call creates a fresh temporary copy of the fixture so tests can write
 * freely without affecting the committed .db file or other test runs.
 *
 * @param name - fixture name (file in tooling/fixtures/ without .db extension).
 *               Use 'empty' for a fresh schema with no data.
 * @param options.through - stop after this migration tag instead of migrating to head: a test of an old
 *               migration seeds the shape that existed right after it, not today's schema.
 */
export async function openFixture(
  name: 'empty' | 'baseline' | (string & {}) = 'baseline',
  options: { through?: string } = {}
): Promise<FixtureDb> {
  const migrate = async (sqlite: Database.Database) => {
    if (!options.through) return void (await initializeDatabase(sqlite));
    const all = bundledMigrations();
    const last = all.findIndex((migration) => migration.tag === options.through);
    if (last < 0) throw new Error(`openFixture: no migration tagged ${options.through}`);
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite, all.slice(0, last + 1));
  };
  // Create a temp file so each test gets an isolated writable copy.
  const tmpPath = path.join(os.tmpdir(), `emdash-test-${name}-${crypto.randomUUID()}.db`);

  // 'empty' through a tag starts from no file at all; 'empty' at head starts from the migrated template;
  // a named fixture starts from a copy of the committed .db. Either way the runner below migrates what is pending.
  if (name === 'empty' && !options.through) fs.writeFileSync(tmpPath, await migratedEmptyTemplate());
  else if (name !== 'empty') fs.copyFileSync(path.join(fixturesDir, `${name}.db`), tmpPath);

  const sqlite = openPhysicalDatabase(tmpPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');

  // Apply any migrations newer than what the file already has.
  // This is the same runner the production app uses.
  await migrate(sqlite);

  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => {
      sqlite.close();
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${tmpPath}${suffix}`, { force: true });
      }
    },
  };
}

// @@@migrated-template — the head schema is migrated once per test file, in memory, and each openFixture('empty')
// writes those bytes to its own file. initializeDatabase still runs on every copy (nothing pending, so it only
// registers functions and ensures the search and file indexes). Replaying all migrations per call was ~1.4k
// replays per session-main-db run, 132 s of its ~350 s CPU. Kept in memory so a killed worker leaves no file.
let emptyTemplate: Promise<Buffer> | undefined;
function migratedEmptyTemplate(): Promise<Buffer> {
  return (emptyTemplate ??= (async () => {
    const sqlite = new Database(':memory:');
    try {
      await initializeDatabase(sqlite);
      return sqlite.serialize();
    } finally {
      sqlite.close();
    }
  })());
}
