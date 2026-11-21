// A group's folder on this machine whose directory is gone, and its explicit repair. Restoring points the same folder
// (its id, its group, the sessions that name it) at a directory the person picks; nothing is guessed from names.
import path from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import { canonicalPath } from '@gugu/session-core/files';
import { err, ok, type Result } from '@gugu/session-shared';
import { db } from '@main/db/client';
import { workspaces } from '@main/db/schema';
import { events } from '@main/lib/events';
import { getDirectoryStatus } from '@main/core/utils/directory-status';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import { foldersChangedChannel } from '@shared/core/folders/folders';
import type { ProjectRecoveryError as FolderRecoveryError, UnavailableProject as UnavailableFolder } from '@shared/projects';
import { folderAtPath, getFolder, listFolders, type Folder } from './folders';
import { folderPathStatus } from './folder-path-status';

function unavailable(folder: Folder): UnavailableFolder {
  return { id: folder.id, name: path.basename(folder.path), path: folder.path, chatId: folder.chatId };
}

/** Same directory probe as opening a folder; an inspection failure is never evidence of a missing folder. */
export async function listUnavailableFolders(): Promise<UnavailableFolder[]> {
  const bound = listFolders();
  const states = new Map(bound.map((folder) => [folder.id, getDirectoryStatus(folder.path).kind]));
  // A group with another usable (or unverified) folder on this machine is not lost here.
  return bound.filter((folder) => states.get(folder.id) === 'not-directory' &&
    !bound.some((other) => other.chatId === folder.chatId && states.get(other.id) !== 'not-directory'))
    .map(unavailable);
}

/** Exact recorded path only: a moved or renamed directory never inherits an old folder's identity. */
export async function findRetainedFolderAtPath(folderPath: string): Promise<UnavailableFolder | null> {
  const folder = folderAtPath(canonicalPath(folderPath));
  return folder?.chatId ? unavailable(folder) : null;
}

export async function inspectFolderRecovery(folderId: string, folderPath: string): Promise<Result<{ path: Folder['path']; isGitRepo: boolean }, FolderRecoveryError>> {
  if (!getFolder(folderId)) return err({ type: 'not-found', message: `folder ${folderId} not found` });
  let target: Folder['path'];
  try { target = canonicalPath(folderPath); }
  catch { return err({ type: 'invalid-directory', message: `not a directory: ${folderPath}` }); }
  const status = await folderPathStatus(target);
  if (status.error) return err({ type: 'inspect-failed', message: status.error.message });
  if (!status.isDirectory) return err({ type: 'invalid-directory', message: `not a directory: ${target}` });
  const occupant = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.key, computeWorkspaceKey(target))).get();
  if (occupant && occupant.id !== folderId) return err({ type: 'path-conflict', message: `${target} is already folder ${occupant.id}` });
  return ok({ path: target, isGitRepo: status.isGitRepo });
}

/** User-selected repair only. The folder keeps its id, group and sessions; only its directory changes. */
export async function restoreFolder(folderId: string, folderPath: string): Promise<Result<Folder, FolderRecoveryError>> {
  const inspected = await inspectFolderRecovery(folderId, folderPath);
  if (!inspected.success) return inspected;
  // Loaded on use: the runtime registry pulls in Git and account services the folder listing never needs.
  const { folderRuntimes } = await import('@main/core/workspaces/folder-runtime/folder-runtimes');
  const closed = await folderRuntimes.close(folderId);
  if (!closed.success) return err({ type: 'close-failed', message: closed.error.message });
  const { path: target, isGitRepo } = inspected.data;
  const key = computeWorkspaceKey(target);
  const moved = db.transaction((tx) => {
    if (tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.key, key), ne(workspaces.id, folderId))).get()) return false;
    tx.update(workspaces).set({ path: target, key, gitless: !isGitRepo }).where(eq(workspaces.id, folderId)).run();
    return true;
  });
  if (!moved) return err({ type: 'path-conflict', message: `${target} is already another folder` });
  const restored = getFolder(folderId)!;
  if (restored.chatId) events.emit(foldersChangedChannel, { chatIds: [restored.chatId] });
  return ok(restored);
}
