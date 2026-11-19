import { useCallback, useEffect, useState } from 'react';
import type { FolderRecord } from '@shared/core/folders/folders';
import { rpcOn } from '@renderer/lib/ipc';
import { groupFoldersStore, type GroupFolder } from './group-folders-store';

/**
 * A group's folders as the folder card and the composer's folder picker show them (both read one state, passed down from
 * the group page: ❌ each reading its own). Which folder a new task starts in is one choice per group: picking a paper on the
 * card and picking in the tray are the same choice.
 */

/** Per group, the folder a new task starts in: survives switching away and back; none chosen = the default (first) one. */
const folderChoice = new Map<string, string>();
/** Per group, the folder bound a moment ago (marked「刚挂上」 and drawn first). */
const freshFolders = new Map<string, string>();

/** A group holds at most this many folders over all machines (owner 2026-10-27: more gets strange). */
export const MAX_GROUP_FOLDERS = 20;

/** Picking a folder in the group picker (the composer tray) starts the next task there. */
export function rememberFolderChoice(chatId: string, folderId: string): void {
  folderChoice.set(chatId, folderId);
}

/** The folder a new task starts in on its machine by default: the first among the group's folders there. */
export function isDefaultFolder(folder: GroupFolder, folders: readonly GroupFolder[]): boolean {
  return !folders.some((other) => other.deviceId === folder.deviceId && other.sort < folder.sort);
}

export function chosenFolderOf(chatId: string, folders: readonly GroupFolder[] | null): GroupFolder | null {
  if (!folders || folders.length === 0) return null;
  const chosen = folderChoice.get(chatId);
  return folders.find((folder) => folder.id === chosen) ?? folders[0]!;
}

export type GroupFoldersState = {
  /** null = not known yet (this computer has not answered and the account's record is still on its first read). */
  folders: readonly GroupFolder[] | null;
  /** Nothing could be read at all: the card says so (the cause is in the log), ❌ an empty card pretending. */
  loadError: boolean;
  /** The account's record could not be read this time: the offline folders listed are the ones read before. */
  stale: boolean;
  chosen: GroupFolder | null;
  /** The folder bound a moment ago (its id). */
  fresh: string | undefined;
  choose: (folderId: string) => void;
  reload: () => void;
  /** A folder just bound here (the undo of a detach rebinds it): marked fresh. */
  bound: (folder: FolderRecord) => void;
  /** Unbind a folder from the group (its files, sessions and history stay); throws when it could not. */
  detach: (folder: GroupFolder) => Promise<void>;
};

export function useGroupFolders(chatId: string): GroupFoldersState {
  const [, setChoiceTick] = useState(0);
  const [fresh, setFresh] = useState<string | undefined>(() => freshFolders.get(chatId));
  useEffect(() => setFresh(freshFolders.get(chatId)), [chatId]);
  const hereAnswered = groupFoldersStore.answers.has('');
  const accountRead = groupFoldersStore.status !== 'loading';
  const listed = groupFoldersStore.foldersOf(chatId);
  const folders = listed.length > 0 || hereAnswered || accountRead ? listed : null;
  const loadError = listed.length === 0 && !hereAnswered && groupFoldersStore.status === 'error';
  const choose = useCallback((folderId: string) => {
    folderChoice.set(chatId, folderId);
    setChoiceTick((tick) => tick + 1);
  }, [chatId]);
  const reload = useCallback(() => {
    void groupFoldersStore.readMachine(null);
    void groupFoldersStore.refresh();
  }, []);
  const bound = useCallback((folder: FolderRecord) => {
    freshFolders.set(chatId, folder.id);
    setFresh(folder.id);
  }, [chatId]);
  const detach = useCallback(async (folder: GroupFolder) => {
    const result = await rpcOn(folder.deviceId).folders.unbindFolder(folder.id);
    if (!result.success) throw new Error(result.error.type, { cause: result.error });
    if (freshFolders.get(chatId) === folder.id) {
      freshFolders.delete(chatId);
      setFresh(undefined);
    }
    if (folderChoice.get(chatId) === folder.id) folderChoice.delete(chatId);
    void groupFoldersStore.readMachine(folder.deviceId);
  }, [chatId]);
  return { folders, loadError, stale: groupFoldersStore.status === 'error', chosen: chosenFolderOf(chatId, folders), fresh, choose, reload, bound, detach };
}
