import { afterEach, describe, expect, it } from 'vitest';
import { chmod, link, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CREATION_RECORD_BYTES, openCreationAttachmentJournal } from './creation-attachment-journal';

const roots: string[] = [];
const fresh = async () => { const root = await mkdtemp(join(tmpdir(), 'creation-journal-')); roots.push(root); return root; };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('POSIX bounded private creation facts', () => {
  it('reopens complete private records and keeps an exclusive fact immutable', async () => {
    const root = await fresh(), journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'request');
    expect(await journal.append('creating', { conversationId: 'original' })).toBe(true);
    expect(await journal.append('creating', { conversationId: 'original' })).toBe(false);
    expect(await (await openCreationAttachmentJournal(root, 'owner', 'device', 'request')).read('creating')).toEqual({ conversationId: 'original' });
    await expect(journal.append('creating', { conversationId: 'other' })).rejects.toThrow('conflicts');
  });
  it('refuses an oversized sparse record before allocating or reading its body', async () => {
    const root = await fresh(), journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'request');
    const [key] = await readdir(root), file = await open(join(root, key, 'creating.json'), 'wx', 0o600);
    try { await file.truncate(MAX_CREATION_RECORD_BYTES + 1); } finally { await file.close(); }
    await expect(journal.read('creating')).rejects.toThrow('invalid size');
  });
  it('rejects invalid UTF-8 and partial JSON instead of treating corruption as an absent intent', async () => {
    const root = await fresh(), journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'request');
    const [key] = await readdir(root), path = join(root, key, 'creating.json');
    await writeFile(path, Buffer.from([0xff]), { mode: 0o600 });
    await expect(journal.read('creating')).rejects.toThrow();
    await writeFile(path, '{'); await expect(journal.read('creating')).rejects.toThrow('cannot be read');
  });
  it('keeps POSIX group/other refusal and rejects hard-linked records', async () => {
    const root = await fresh();
    await chmod(root, 0o755);
    await expect(openCreationAttachmentJournal(root, 'owner', 'device', 'request')).rejects.toThrow('private directory');
    await chmod(root, 0o700);
    const journal = await openCreationAttachmentJournal(root, 'owner', 'device', 'request');
    await journal.append('creating', { conversationId: 'original' });
    const [key] = await readdir(root); await link(join(root, key, 'creating.json'), join(root, 'alias'));
    await expect(journal.read('creating')).rejects.toThrow('private regular file');
  });
});
