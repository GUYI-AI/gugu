// @@@group-folders — what this device publishes to the account (publish_chat_folders): its folders bound to a group.
import { foldersChangedChannel } from '@shared/core/folders/folders';
import { events, tapMainEvents } from '@main/lib/events';
import { bindFolder, getFolder, listFolders } from './folders';
import type { PublishedFolder } from '@gugu/core/cloud/chatFolders';

export async function listPublishedFolders(): Promise<PublishedFolder[]> {
  return listFolders().flatMap((folder) => folder.chatId
    ? [{ folderId: folder.id, chatId: folder.chatId, path: folder.path, attachedAt: folder.attachedAt }] : []);
}

/** Folders may have changed here (bound, unbound, moved, reordered): publish again. */
export function onFoldersMaybeChanged(run: () => void): () => void {
  return tapMainEvents((channel) => { if (channel === foldersChangedChannel.name) run(); });
}

/** The account refused these folders' bindings (no such group, or not a member): unbind them here. */
export async function unbindRefusedFolders(folderIds: readonly string[]): Promise<void> {
  const chatIds: string[] = [];
  for (const id of folderIds) {
    const folder = getFolder(id);
    if (folder?.chatId && bindFolder(id, null)) chatIds.push(folder.chatId);
  }
  if (chatIds.length) events.emit(foldersChangedChannel, { chatIds });
}
