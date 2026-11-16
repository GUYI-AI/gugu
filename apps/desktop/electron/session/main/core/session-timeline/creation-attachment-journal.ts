import { createHash } from 'node:crypto';
import { mkdir, lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionCreateAttachmentDraftRequest, SessionCreateAttachmentDraftResult } from '@gugu/session-core/session-record/creation-attachment-protocol';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';

export type CreationIntent = {
  version: 1; ownerId: string; deviceId: string; fingerprint: string;
  conversationId: string; request: SessionCreateAttachmentDraftRequest;
};
export type CreationStages = {
  intent: CreationIntent;
  creating: { conversationId: string };
  created: SessionCreateAttachmentDraftResult;
  prepared: { placementKey: string; files: TurnFileRef[] };
  admitted: { initialMessageId: string };
};

export function attachmentCreationUnverified(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'attachment_creation_unverified' });
}

/** Append-only facts: a crash cannot turn an uncertain creation or admission back into a fresh request. */
export async function openCreationAttachmentJournal(root: string, ownerId: string, deviceId: string, requestId: string) {
  const key = createHash('sha256').update(JSON.stringify([ownerId, deviceId, requestId])).digest('hex');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, key);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  for (const path of [root, directory]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw attachmentCreationUnverified('Attachment creation storage must be a private directory');
    }
  }
  async function read<K extends keyof CreationStages>(stage: K): Promise<CreationStages[K] | null> {
    const path = join(directory, `${stage}.json`);
    let value: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
        throw attachmentCreationUnverified('Attachment creation storage is not a private regular file');
      }
      value = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try { return JSON.parse(value) as CreationStages[K]; }
    catch { throw attachmentCreationUnverified('The original attachment creation record cannot be read'); }
  }
  async function append<K extends keyof CreationStages>(stage: K, value: CreationStages[K]): Promise<boolean> {
    const path = join(directory, `${stage}.json`);
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await read(stage);
      if (!isDeepStrictEqual(existing, value)) throw attachmentCreationUnverified('The original attachment creation fact conflicts');
      const prior = await open(path, 'r');
      try { await prior.sync(); } finally { await prior.close(); }
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      return false;
    }
    // A partial write stays unverified. Never delete it and silently restart the creation saga.
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return true;
  }
  return { read, append };
}
