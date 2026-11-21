import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STANDALONE_MAC_ASSET } from './standalone-kernel-catalog';
import { readChromeStorageKeys, STORAGE_LAYOUT_CHECKED_FOR, type OpenSqlite } from './standalone-chrome-storage';

// Exactly what Chrome for Testing 158.0.8127.36 wrote (`sqlite3 .schema`, 2026-11-21). A new Chrome that moves or renames
// either table must turn this file red before a clear-site-data silently skips origins.
const LOCAL_STORAGE_SCHEMA = [
  'CREATE TABLE maps(row_id INTEGER PRIMARY KEY AUTOINCREMENT,storage_key BLOB NOT NULL,last_accessed INTEGER,last_modified INTEGER,total_size INTEGER)',
  'CREATE UNIQUE INDEX maps_by_storage_key ON maps(storage_key)',
];
const QUOTA_MANAGER_SCHEMA = [
  'CREATE TABLE buckets(id INTEGER PRIMARY KEY AUTOINCREMENT, storage_key TEXT NOT NULL, host TEXT NOT NULL, name TEXT NOT NULL, use_count INTEGER NOT NULL, last_accessed INTEGER NOT NULL, last_modified INTEGER NOT NULL, expiration INTEGER NOT NULL, quota INTEGER NOT NULL, persistent INTEGER NOT NULL, durability INTEGER NOT NULL) STRICT',
  'CREATE UNIQUE INDEX buckets_by_storage_key ON buckets(storage_key, name)',
];

const open: OpenSqlite = file => {
  const db = new DatabaseSync(file);
  return { prepare: sql => ({ all: () => db.prepare(sql).all() }), close: () => db.close() };
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function chromeProfile(options: { local?: string[] | null; quota?: string[] | null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'chrome-storage-'));
  roots.push(root);
  const profile = path.join(root, 'profile');
  await mkdir(path.join(profile, 'Default', 'WebStorage'), { recursive: true });
  const databases: DatabaseSync[] = [];
  if (options.local !== null) {
    const db = new DatabaseSync(path.join(profile, 'Default', 'LocalStorage'));
    // Chrome: WAL, and it keeps the file locked for itself while it runs.
    db.exec('PRAGMA journal_mode=WAL; PRAGMA locking_mode=EXCLUSIVE');
    for (const statement of LOCAL_STORAGE_SCHEMA) db.exec(statement);
    for (const key of options.local ?? []) db.prepare('INSERT INTO maps(storage_key) VALUES (?)').run(Buffer.from(key));
    databases.push(db);
  }
  if (options.quota !== null) {
    const db = new DatabaseSync(path.join(profile, 'Default', 'WebStorage', 'QuotaManager'));
    for (const statement of QUOTA_MANAGER_SCHEMA) db.exec(statement);
    for (const key of options.quota ?? []) db.prepare("INSERT INTO buckets(storage_key, host, name, use_count, last_accessed, last_modified, expiration, quota, persistent, durability) VALUES (?, 'h', '_default', 0, 0, 0, 0, 0, 0, 0)").run(key);
    databases.push(db);
  }
  return { root, profile, close: () => databases.forEach(db => db.close()) };
}
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

describe('storage keys Chrome keeps for sites', () => {
  it('is pinned to the Chrome the layout was checked against', () => {
    expect(STORAGE_LAYOUT_CHECKED_FOR).toBe(STANDALONE_MAC_ASSET.version);
  });

  it('lists local storage and quota-managed sites, web only, without duplicates', async () => {
    const f = await chromeProfile({
      local: ['https://only-local.test/', 'https://both.test/', 'chrome-extension://abc/'],
      quota: ['https://sw-only.test/', 'https://both.test/', 'http://127.0.0.1:8080/', 'https://a.test/^0https://top.test', 'chrome://x/', 'file:///tmp/'],
    });
    try {
      expect(readChromeStorageKeys(f.profile, { open, scratch: f.root }).sort()).toEqual([
        'http://127.0.0.1:8080/', 'https://a.test/^0https://top.test', 'https://both.test/', 'https://only-local.test/', 'https://sw-only.test/',
      ]);
    } finally { f.close(); }
  });

  it('reads a profile whose files Chrome still holds open and locked, and leaves those files and the scratch directory alone', async () => {
    const f = await chromeProfile({ local: ['https://pending.test/'], quota: ['https://x.test/'] });
    try {
      // The live file cannot be opened by anyone else; only a copy can.
      expect(() => open(path.join(f.profile, 'Default', 'LocalStorage')).prepare('SELECT * FROM maps').all()).toThrow(/locked/);
      const before = await Promise.all(['LocalStorage', 'WebStorage/QuotaManager'].map(name => digest(path.join(f.profile, 'Default', name))));
      expect(readChromeStorageKeys(f.profile, { open, scratch: f.root })).toEqual(expect.arrayContaining(['https://pending.test/', 'https://x.test/']));
      const after = await Promise.all(['LocalStorage', 'WebStorage/QuotaManager'].map(name => digest(path.join(f.profile, 'Default', name))));
      expect(after).toEqual(before);
      expect(await readdir(f.root)).toEqual(['profile']);
    } finally { f.close(); }
  });

  it('treats a profile with no local storage yet as having none, but needs the quota database', async () => {
    const noLocal = await chromeProfile({ local: null, quota: ['https://x.test/'] });
    try { expect(readChromeStorageKeys(noLocal.profile, { open, scratch: noLocal.root })).toEqual(['https://x.test/']); } finally { noLocal.close(); }
    const noQuota = await chromeProfile({ local: ['https://x.test/'], quota: null });
    try { expect(() => readChromeStorageKeys(noQuota.profile, { open, scratch: noQuota.root })).toThrow(/QuotaManager/); } finally { noQuota.close(); }
  });

  it('refuses a layout it does not know instead of listing fewer sites', async () => {
    const f = await chromeProfile({ quota: [] });
    try {
      const database = new DatabaseSync(path.join(f.profile, 'Default', 'WebStorage', 'QuotaManager'));
      database.exec('DROP TABLE buckets; CREATE TABLE buckets(id INTEGER PRIMARY KEY, origin TEXT)');
      database.close();
      expect(() => readChromeStorageKeys(f.profile, { open, scratch: f.root })).toThrow(/buckets.*storage_key/);
      const other = new DatabaseSync(path.join(f.profile, 'Default', 'WebStorage', 'QuotaManager'));
      other.exec('DROP TABLE buckets');
      other.close();
      expect(() => readChromeStorageKeys(f.profile, { open, scratch: f.root })).toThrow(/buckets.*storage_key/);
    } finally { f.close(); }
  });

  it('reports a database it cannot open, naming it', async () => {
    const f = await chromeProfile({ local: [], quota: [] });
    try {
      const busy: OpenSqlite = file => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', file }); };
      expect(() => readChromeStorageKeys(f.profile, { open: busy, scratch: f.root })).toThrow(/LocalStorage.*database is locked/);
      expect(await readdir(f.root)).toEqual(['profile']);
    } finally { f.close(); }
  });
});
