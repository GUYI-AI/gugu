import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionCreateAttachmentDraftRequest, SessionCreateAttachmentDraftResult } from '@gugu/session-core/session-record/creation-attachment-protocol';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';
import type { WindowsJournalProtection } from './creation-attachment-windows-journal';

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
export type CreationAttachmentJournal = {
  read<K extends keyof CreationStages>(stage: K): Promise<CreationStages[K] | null>;
  append<K extends keyof CreationStages>(stage: K, value: CreationStages[K]): Promise<boolean>;
};
/** Storage capacity, not truncation: refuse before creating a task or allocating an unbounded read. */
export const MAX_CREATION_RECORD_BYTES = 64 * 1024 * 1024;
export function attachmentCreationUnverified(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'attachment_creation_unverified' });
}
export function creationRecordText(value: unknown): string {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CREATION_RECORD_BYTES) {
    throw attachmentCreationUnverified('The attachment creation record exceeds its storage capacity');
  }
  return text;
}

/** Append-only facts: a crash cannot turn an uncertain creation or admission back into a fresh request. */
export async function openCreationAttachmentJournal(root: string, ownerId: string, deviceId: string, requestId: string,
  options: { platform?: NodeJS.Platform; windowsProtection?: WindowsJournalProtection } = {},
): Promise<CreationAttachmentJournal> {
  const platform = options.platform ?? process.platform;
  const key = createHash('sha256').update(JSON.stringify([ownerId, deviceId, requestId])).digest('hex');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, key);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  for (const path of [root, directory]) {
    const info = await lstat(path);
    // Windows mode bits are synthesized, not a DACL. That branch requires OS-bound encryption below.
    if (!info.isDirectory() || info.isSymbolicLink() || platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw attachmentCreationUnverified('Attachment creation storage must be a private directory');
    }
  }
  if (platform === 'win32') {
    const { openWindowsCreationJournal } = await import('./creation-attachment-windows-journal');
    return openWindowsCreationJournal(directory, key, options.windowsProtection);
  }
  async function read<K extends keyof CreationStages>(stage: K): Promise<CreationStages[K] | null> {
    const path = join(directory, `${stage}.json`);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    let value: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
        throw attachmentCreationUnverified('Attachment creation storage is not a private regular file');
      }
      if (!Number.isSafeInteger(info.size) || info.size < 1 || info.size > MAX_CREATION_RECORD_BYTES) {
        throw attachmentCreationUnverified('The original attachment creation record has an invalid size');
      }
      const bytes = Buffer.alloc(info.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      const after = await handle.stat();
      if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
        throw attachmentCreationUnverified('The original attachment creation record changed during its bounded read');
      }
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } finally { await handle.close(); }
    try { return JSON.parse(value) as CreationStages[K]; }
    catch { throw attachmentCreationUnverified('The original attachment creation record cannot be read'); }
  }
  async function syncDirectory() {
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  async function append<K extends keyof CreationStages>(stage: K, value: CreationStages[K]): Promise<boolean> {
    const text = creationRecordText(value), path = join(directory, `${stage}.json`);
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await read(stage);
      if (!isDeepStrictEqual(existing, value)) throw attachmentCreationUnverified('The original attachment creation fact conflicts');
      const prior = await open(path, constants.O_RDWR | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await prior.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw attachmentCreationUnverified('The original attachment fact is not private');
        await prior.sync();
      } finally { await prior.close(); }
      await syncDirectory();
      return false;
    }
    // A partial write stays unverified. Never delete it and silently restart the creation saga.
    try { await handle.writeFile(text); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirectory();
    return true;
  }
  return { read, append };
}
