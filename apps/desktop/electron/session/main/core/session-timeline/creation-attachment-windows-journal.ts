import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { safeStorage } from 'electron';
import { attachmentCreationUnverified as unverified, creationRecordText, MAX_CREATION_RECORD_BYTES,
  type CreationAttachmentJournal, type CreationStages } from './creation-attachment-journal';

export type WindowsJournalProtection = {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
};

/** This journal requires Windows DPAPI. The headless safeStorage shim is file-key based. */
function protection(provided?: WindowsJournalProtection): WindowsJournalProtection {
  const store = provided ?? (process.versions.electron ? safeStorage : undefined);
  if (!store?.isEncryptionAvailable()) throw unverified('Windows private attachment storage is unavailable');
  return store;
}

/** Windows SQLite's VFS owns writable flush handles and transaction recovery; no POSIX directory fsync is attempted. */
export async function openWindowsCreationJournal(directory: string, binding: string, provided?: WindowsJournalProtection): Promise<CreationAttachmentJournal> {
  const secure = protection(provided);
  const path = join(directory, 'facts.sqlite');
  const { openPhysicalDatabase } = await import('../../db/physical-connection');
  function decode<K extends keyof CreationStages>(stage: K, payload: Buffer): CreationStages[K] {
    if (!Buffer.isBuffer(payload) || payload.length > MAX_CREATION_RECORD_BYTES) throw unverified('The encrypted creation fact exceeds its storage capacity');
    let envelope: { binding: string; stage: K; value: CreationStages[K] };
    try { envelope = JSON.parse(secure.decryptString(payload)); }
    catch { throw unverified('The original encrypted creation fact cannot be read'); }
    if (envelope?.binding !== binding || envelope.stage !== stage || !('value' in envelope)) throw unverified('The encrypted creation fact belongs to another request');
    return envelope.value;
  }
  async function access<T>(work: (db: Database.Database) => T): Promise<T> {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw unverified('The private creation database is not a regular single-link file');
    const db = openPhysicalDatabase(path);
    try {
      db.pragma('busy_timeout = 1000');
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = EXTRA');
      if (db.pragma('synchronous', { simple: true }) !== 3 || db.pragma('journal_mode', { simple: true }) !== 'delete') {
        throw unverified('Windows attachment journal durability could not be established');
      }
      db.exec(`CREATE TABLE IF NOT EXISTS creation_facts (stage TEXT PRIMARY KEY, payload BLOB NOT NULL CHECK(length(payload) BETWEEN 1 AND ${MAX_CREATION_RECORD_BYTES}))`);
      return work(db);
    } finally { db.close(); }
  }
  const select = (db: Database.Database, stage: keyof CreationStages) => {
    const row = db.prepare('SELECT length(payload) AS bytes, CASE WHEN length(payload) <= ? THEN payload END AS payload FROM creation_facts WHERE stage = ?')
      .get(MAX_CREATION_RECORD_BYTES, stage) as { bytes: number; payload: Buffer | null } | undefined;
    if (!row) return null;
    if (row.bytes < 1 || row.bytes > MAX_CREATION_RECORD_BYTES || !Buffer.isBuffer(row.payload)) throw unverified('The encrypted creation fact has an invalid size');
    return row.payload;
  };
  return {
    async read<K extends keyof CreationStages>(stage: K) {
      return access(db => { const payload = select(db, stage); return payload === null ? null : decode<K>(stage, payload); });
    },
    async append<K extends keyof CreationStages>(stage: K, value: CreationStages[K]) {
      const plain = creationRecordText({ binding, stage, value });
      const sealed = secure.encryptString(plain);
      if (!Buffer.isBuffer(sealed) || !sealed.length || sealed.length > MAX_CREATION_RECORD_BYTES) throw unverified('The encrypted creation fact exceeds its storage capacity');
      return access(db => db.transaction(() => {
        const existing = select(db, stage);
        if (existing !== null) {
          if (!isDeepStrictEqual(decode<K>(stage, existing), value)) throw unverified('The original attachment creation fact conflicts');
          return false;
        }
        db.prepare('INSERT INTO creation_facts (stage, payload) VALUES (?, ?)').run(stage, sealed);
        return true;
      }).immediate());
    },
  };
}
