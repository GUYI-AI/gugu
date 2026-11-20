import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The Chrome for Testing release whose on-disk layout below was checked (`standalone-chrome-storage.test.ts` holds that
 * release's table schemas). Moving the pinned Chrome to another release fails a test until the layout is checked again.
 */
export const STORAGE_LAYOUT_CHECKED_FOR = '158.0.8127.36';

export type SqliteDatabase = { prepare(sql: string): { all(): unknown[] }; close(): void };
export type OpenSqlite = (file: string) => SqliteDatabase;

// Both are SQLite files Chrome keeps open with an exclusive lock for as long as it runs, so no other process can open
// them in place (SQLITE_BUSY, measured). They are read as copies, with the write-ahead log or journal beside them.
const SOURCES = [
  { name: 'LocalStorage', file: ['Default', 'LocalStorage'], table: 'maps', optional: true },
  { name: 'QuotaManager', file: ['Default', 'WebStorage', 'QuotaManager'], table: 'buckets', optional: false },
] as const;

/**
 * Every site (as Chrome's serialized storage key, e.g. `https://a.test/`) that a profile of the running Chrome holds
 * local storage or quota-managed data (IndexedDB, Cache Storage, service workers, file systems) for. No CDP command lists
 * them. Throws when a source cannot be read or no longer has the expected shape: never a shorter list.
 */
export function readChromeStorageKeys(profile: string, options: { open: OpenSqlite; scratch?: string }): string[] {
  const keys = new Set<string>();
  for (const source of SOURCES) {
    const original = path.join(profile, ...source.file);
    if (!existsSync(original)) {
      // A profile that never used local storage has no such file; the quota database exists as soon as Chrome has run.
      if (source.optional) continue;
      throw new Error(`Chrome's ${source.name} database is missing from this profile, so its sites cannot be listed`);
    }
    const scratch = mkdtempSync(path.join(options.scratch ?? tmpdir(), 'chrome-storage-'));
    try {
      for (const suffix of ['', '-wal', '-journal']) {
        if (existsSync(original + suffix)) copyFileSync(original + suffix, path.join(scratch, path.basename(original) + suffix));
      }
      const database = options.open(path.join(scratch, path.basename(original)));
      try {
        const columns = database.prepare(`PRAGMA table_info(${source.table})`).all() as { name?: string }[];
        if (!columns.some(column => column.name === 'storage_key')) {
          throw new Error(`table ${source.table} with a storage_key column is not there (this Chrome's layout is not the one checked)`);
        }
        for (const row of database.prepare(`SELECT storage_key FROM ${source.table}`).all() as { storage_key?: unknown }[]) {
          const key = typeof row.storage_key === 'string' ? row.storage_key
            : row.storage_key instanceof Uint8Array ? Buffer.from(row.storage_key).toString('utf8') : null;
          if (key === null) throw new Error(`a storage_key in ${source.table} is not text`);
          if (/^https?:\/\//i.test(key)) keys.add(key);
        }
      } finally { database.close(); }
    } catch (error) {
      throw new Error(`Chrome's ${source.name} database cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  return [...keys];
}
