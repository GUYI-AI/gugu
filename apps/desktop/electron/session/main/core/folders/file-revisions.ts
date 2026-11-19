// @@@group-folders — the versions this device holds (formerly the `files` part of taskpage-project-groups.json).
//
// A device-held version names its holder's key (host_project_id): a folder id (this release on), the device store, or a
// project id of an earlier release (legacy_project_aliases → that project's root folder; its relative paths are relative
// to that root). It is held here while that folder is still bound to the version's chat — the rule the account applies
// (chat.device_holds). The cache keeps the newest record per item and account; a miss asks the database.
import { and, eq, sql } from 'drizzle-orm';
import { DEVICE_STORE, fileRefKey, requireFileRevision, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver';
import { db } from '@main/db/client';
import { fileRevisionCache } from '@main/db/schema';
import { getFolder } from './folders';
import { legacyProject } from './legacy-project-aliases';

/** Items whose version records this device caches per account; past it the oldest written go. */
const FILE_CACHE_MAX = 2000;

/** The folder a holder key names here: a folder id, or an earlier release's project id through its root folder. */
function folderOfKey(key: string) {
  const folder = getFolder(key);
  if (folder) return folder;
  const legacy = legacyProject(key);
  return legacy?.rootWorkspaceId ? getFolder(legacy.rootWorkspaceId) : undefined;
}

/** The directory a holder key's relative paths are relative to; null = not on this device. */
export function holderRoot(key: string): string | null {
  return folderOfKey(key)?.path ?? null;
}

/** The first folder this device binds to a chat: where what it sends there is kept. */
export { firstFolderOf } from './first-folder';

function keptHere(revision: FileRevision): boolean {
  if (revision.host_project_id === DEVICE_STORE) return true;
  return !!revision.host_project_id && folderOfKey(revision.host_project_id)?.chatId === revision.chat_id;
}

function record(revision: FileRevision): FileRevision {
  const { source, item_id, version, chat_id, file_name, content_type, size_bytes, sha256, host_device_id, host_project_id, host_account_id, relative_path, workspace } = revision;
  return { source, item_id, version, chat_id, file_name, content_type, size_bytes, sha256, host_device_id, host_project_id, host_account_id, relative_path, ...(workspace ? { workspace } : {}) };
}

function held(ownerId: string, deviceId: string, revision: FileRevision): FileRevision | null {
  requireFileRevision(revision);
  return revision.source === 'local' && !!revision.chat_id && revision.host_account_id === ownerId && revision.host_device_id === deviceId
    && keptHere(revision) ? record(revision) : null;
}

function cached(ownerId: string): FileRevision[] {
  return db.select({ json: fileRevisionCache.revisionJson }).from(fileRevisionCache).where(eq(fileRevisionCache.accountId, ownerId))
    .orderBy(sql`rowid`).all().map((row) => JSON.parse(row.json) as FileRevision);
}

function put(ownerId: string, revision: FileRevision): void {
  db.transaction((tx) => {
    tx.delete(fileRevisionCache).where(and(eq(fileRevisionCache.accountId, ownerId), eq(fileRevisionCache.itemId, revision.item_id!))).run();
    tx.insert(fileRevisionCache).values({ accountId: ownerId, itemId: revision.item_id!, version: revision.version!, revisionJson: JSON.stringify(record(revision)) }).run();
    tx.run(sql`DELETE FROM file_revision_cache WHERE account_id = ${ownerId} AND rowid IN (
      SELECT rowid FROM file_revision_cache WHERE account_id = ${ownerId} ORDER BY rowid
      LIMIT max(0, (SELECT count(*) FROM file_revision_cache WHERE account_id = ${ownerId}) - ${FILE_CACHE_MAX}))`);
  });
}

/** A version this device just published: its record goes into the cache, under a binding still current. */
export function rememberFileRevision(revision: FileRevision, ownerId: string): void {
  requireFileRevision(revision);
  if (revision.source !== 'local' || revision.host_account_id !== ownerId || !revision.chat_id) throw new Error('File owner or group mismatch');
  if (!keptHere(revision)) throw new Error('Folder binding changed');
  put(ownerId, revision);
}

export function findFileByName(chat: string, name: string, ownerId: string, deviceId: string): FileRevision | null {
  const found = cached(ownerId).find((row) => row.chat_id === chat && row.workspace?.path === name);
  return found ? held(ownerId, deviceId, found) : null;
}

export function findFileCopy(key: string, sha: string, ownerId: string, deviceId: string): FileRevision | null {
  const found = cached(ownerId).findLast((row) => row.host_project_id === key && row.sha256 === sha && row.relative_path?.startsWith('.gugu/attachments/'));
  return found ? held(ownerId, deviceId, found) : null;
}

/** The database's record of one version of a file (its current one when no version is named). */
export type FileVersionLookup = (ref: { item_id: string; version?: number }) => Promise<FileRevision | null>;

/**
 * Does this device hold this version of a file: the database's version record says so (this account, this device, a
 * folder still bound to the file's chat, or its device store). A named version the cache has is answered from it (a
 * version record never changes); anything else is asked of the database, and its answer is cached.
 */
export async function readFileRevision(ref: FileRef, ownerId: string, deviceId: string, lookup: FileVersionLookup): Promise<FileRevision | null> {
  fileRefKey(ref);
  if (!('item_id' in ref) || !ownerId || !deviceId) return null;
  const mine = cached(ownerId).find((row) => row.item_id === ref.item_id);
  const answer = ref.version !== undefined && mine?.version === ref.version ? mine
    : await lookup(ref.version === undefined ? { item_id: ref.item_id } : { item_id: ref.item_id, version: ref.version });
  if (!answer || answer.item_id !== ref.item_id || ref.version !== undefined && answer.version !== ref.version) return null;
  const chosen = mine && mine.version === answer.version ? mine : answer;
  const revision = held(ownerId, deviceId, chosen);
  if (revision && chosen !== mine && (!mine || mine.version! < revision.version!)) put(ownerId, revision);
  return revision;
}
