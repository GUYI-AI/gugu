// @@@group-folders — rpc.folders: a machine's folders and which group each is bound to. Renderers call it on any machine
// (rpcOn(machine)); agent tools reach the same operations through group_folder_* (lane D).
import { mkdir } from 'node:fs/promises';
import { and, eq, isNull } from 'drizzle-orm';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { err, ok, type Result } from '@gugu/session-shared';
import { foldersChangedChannel, type FolderError, type FolderPathStatus, type FolderRecord } from '@shared/core/folders/folders';
import { canonicalPath } from '@gugu/session-core/files';
import { db } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import { events } from '@main/lib/events';
import { bindFolder, ensureFolder, folderAtPath, getFolder, listFolders, listUnboundFolders, reorderFolders, type Folder } from './folders';
import { folderPathStatus } from './folder-path-status';

function record(folder: Folder): FolderRecord {
  const [ws] = db.select({ branch: workspaces.branchName }).from(workspaces).where(eq(workspaces.id, folder.id)).limit(1).all();
  const running = db.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.workspaceId, folder.id), isNull(sessions.archivedAt))).all();
  return { ...folder, branch: folder.gitless ? null : ws?.branch ?? null, sessionIds: running.map((row) => row.id) };
}

function changed(...chatIds: (string | null)[]): void {
  const ids = [...new Set(chatIds.filter((id): id is string => !!id))];
  events.emit(foldersChangedChannel, { chatIds: ids });
}

/** This machine's folders of one group, in order; every bound folder when no chat is named. */
export async function listGroupFolders(chatId?: string): Promise<FolderRecord[]> {
  return listFolders(chatId).map(record);
}

/** Every folder recorded on this machine, bound to a group or not (the task home, an App's own directory). */
export async function listAllFolders(): Promise<FolderRecord[]> {
  return [...listFolders(), ...listUnboundFolders()].map(record);
}

/** What is at a path on this machine, and the folder already recorded there. */
export async function inspectFolderPath(path: string): Promise<FolderPathStatus> {
  const status = await folderPathStatus(path);
  const existing = status.isDirectory ? folderAtPath(canonicalPath(path)) : undefined;
  return { ...status, ...(existing ? { existing: record(existing) } : {}) };
}

/**
 * Bind the directory at `path` to a group (recording it as a folder first). A folder bound to another group is refused
 * unless `move` is set; it then moves, and its sessions keep the group they were started in.
 */
export async function bindFolderAtPath(params: { path: string; chatId: string; move?: boolean; create?: boolean }): Promise<Result<FolderRecord, FolderError>> {
  // 「新建群（同时新建一个文件夹）」: the directory is made on this machine first.
  if (params.create) await mkdir(params.path, { recursive: true });
  const status = await folderPathStatus(params.path);
  if (status.error) return err(status.error);
  if (!status.isDirectory) return err({ type: 'not-a-directory', path: params.path });
  const folder = ensureFolder(canonicalPath(params.path), { gitless: !status.isGitRepo });
  if (folder.chatId && folder.chatId !== params.chatId && !params.move) {
    return err({ type: 'bound-elsewhere', id: folder.id, chatId: folder.chatId });
  }
  const before = folder.chatId;
  if (bindFolder(folder.id, params.chatId)) changed(before, params.chatId);
  return ok(record(getFolder(folder.id)!));
}

/** Unbind a folder from its group (files, sessions and history stay); the undo is bindFolderAtPath with its path. */
export async function unbindFolder(id: string): Promise<Result<FolderRecord, FolderError>> {
  const folder = getFolder(id);
  if (!folder) return err({ type: 'folder-not-found', id });
  if (bindFolder(id, null)) changed(folder.chatId);
  return ok(record(getFolder(id)!));
}

export async function reorderGroupFolders(params: { chatId: string; ids: string[] }): Promise<void> {
  reorderFolders(params.chatId, params.ids);
  changed(params.chatId);
}

export const folderController = createRPCController({
  listGroupFolders,
  listAllFolders,
  inspectFolderPath,
  bindFolderAtPath,
  unbindFolder,
  reorderGroupFolders,
});
