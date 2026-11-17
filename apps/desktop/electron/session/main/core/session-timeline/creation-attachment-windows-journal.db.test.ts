import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openCreationAttachmentJournal } from './creation-attachment-journal';
import { openWindowsCreationJournal, type WindowsJournalProtection } from './creation-attachment-windows-journal';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const fresh = async () => { const root = await mkdtemp(join(tmpdir(), 'creation-win-journal-')); roots.push(root); return root; };
/** Real authenticated ciphertext, injected only for portable tests; production uses Electron's Windows DPAPI. */
function protection(): WindowsJournalProtection {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString: text => { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, body, cipher.getAuthTag()]); },
    decryptString: bytes => { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'); },
  };
}

describe('Windows private creation persistence (real SQLite, portable encryption fixture)', () => {
  it('does not mistake synthesized mode bits for a DACL; persists sealed facts across reopen', async () => {
    const root = await fresh(); await chmod(root, 0o777);
    const secure = protection(), options = { platform: 'win32' as const, windowsProtection: secure };
    const journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'request', options);
    expect(await journal.append('creating', { conversationId: 'private-canary' })).toBe(true);
    expect(await journal.append('creating', { conversationId: 'private-canary' })).toBe(false);
    const restarted = await openCreationAttachmentJournal(root, 'owner', 'device', 'request', options);
    expect(await restarted.read('creating')).toEqual({ conversationId: 'private-canary' });
    const [key] = await readdir(root), path = join(root, key, 'facts.sqlite');
    expect((await readFile(path)).includes(Buffer.from('private-canary'))).toBe(false);
    const db = new Database(path); try {
      expect(db.prepare('SELECT count(*) AS n FROM creation_facts').get()).toEqual({ n: 1 });
    } finally { db.close(); }
    expect((await readdir(join(root, key))).sort()).toEqual(['facts.sqlite']);
  });
  it('fails before any plaintext or database is created when OS protection is unavailable', async () => {
    const root = await fresh(), secure = { ...protection(), isEncryptionAvailable: () => false };
    await expect(openCreationAttachmentJournal(root, 'owner', 'device', 'request', { platform: 'win32', windowsProtection: secure })).rejects.toThrow('unavailable');
    const [key] = await readdir(root); expect(await readdir(join(root, key))).toEqual([]);
  });
  it('binds sealed facts to their request and refuses a different OS key or corrupted ciphertext', async () => {
    const root = await fresh(), secure = protection();
    const journal = await openWindowsCreationJournal(root, 'binding-a', secure);
    await journal.append('creating', { conversationId: 'original' });
    await expect((await openWindowsCreationJournal(root, 'binding-b', secure)).read('creating')).rejects.toThrow('another request');
    await expect((await openWindowsCreationJournal(root, 'binding-a', protection())).read('creating')).rejects.toThrow('cannot be read');
    const db = new Database(join(root, 'facts.sqlite')); try { db.prepare('UPDATE creation_facts SET payload = ?').run(Buffer.from('corrupt')); } finally { db.close(); }
    await expect(journal.read('creating')).rejects.toThrow('cannot be read');
  });
  it('uses an immutable SQLite insert under a write transaction and preserves a failed encrypt for retry', async () => {
    const root = await fresh(), secure = protection(), encode = vi.spyOn(secure, 'encryptString');
    const journal = await openWindowsCreationJournal(root, 'binding', secure);
    encode.mockImplementationOnce(() => { throw new Error('OS encryption unavailable'); });
    await expect(journal.append('creating', { conversationId: 'original' })).rejects.toThrow('unavailable');
    expect(await journal.read('creating')).toBeNull();
    expect(await journal.append('creating', { conversationId: 'original' })).toBe(true);
    await expect(journal.append('creating', { conversationId: 'other' })).rejects.toThrow('conflicts');
    expect(await journal.read('creating')).toEqual({ conversationId: 'original' });
  });
});
