// group_folder* for agents (lane D of C1): the same folder operations the group page uses (controller.ts), answered in the
// agent's words. They run on the device that holds the folders; the host routes `device` there before this is reached.
import type { FolderRecord } from '@shared/core/folders/folders';
import { bindFolderAtPath, inspectFolderPath, listGroupFolders, unbindFolder } from './controller';

export type GroupFolderAgentAction =
  | { action: 'group_folders'; chat_id?: string }
  | { action: 'group_folder_bind'; chat_id: string; path: string; move?: boolean }
  | { action: 'group_folder_unbind'; chat_id: string; folder_id: string };

export interface GroupFolderOps {
  list: typeof listGroupFolders;
  inspect: typeof inspectFolderPath;
  bind: typeof bindFolderAtPath;
  unbind: typeof unbindFolder;
}

const LOCAL: GroupFolderOps = { list: listGroupFolders, inspect: inspectFolderPath, bind: bindFolderAtPath, unbind: unbindFolder };

const row = (folder: FolderRecord) => ({
  chat_id: folder.chatId, folder_id: folder.id, path: folder.path, git: !folder.gitless, branch: folder.branch,
  sessions: folder.sessionIds.map((session_id) => ({ session_id })),
});

export function isGroupFolderAgentAction(action: { action: string }): action is GroupFolderAgentAction {
  return action.action === 'group_folders' || action.action === 'group_folder_bind' || action.action === 'group_folder_unbind';
}

export async function runGroupFolderAgentAction(action: GroupFolderAgentAction, ops: GroupFolderOps = LOCAL): Promise<unknown> {
  if (action.action === 'group_folders') return (await ops.list(action.chat_id)).map(row);
  if (action.action === 'group_folder_bind') {
    const before = (await ops.inspect(action.path)).existing?.chatId ?? null;
    const bound = await ops.bind({ path: action.path, chatId: action.chat_id, move: action.move });
    if (!bound.success) {
      const error = bound.error;
      if (error.type === 'bound-elsewhere') {
        return { folder_bound_elsewhere: { chat_id: error.chatId }, folder_id: error.id, path: action.path,
          next: 'Bound to another group. Ask the owner, then repeat with move:true to move it; that group keeps its history and sessions.' };
      }
      throw new Error(error.type === 'folder-not-found' ? `folder ${error.id} not found`
        : error.type === 'not-a-directory' ? `${error.path} is not a directory on this device` : `${error.path}: ${error.message}`);
    }
    if (before === action.chat_id) return { ...row(bound.data), already_bound: true };
    return {
      ...row(bound.data), ...(before ? { moved_from: { chat_id: before } } : {}),
      undo: before
        ? { tool: 'group_folder_bind', chat_id: before, path: bound.data.path, move: true }
        : { tool: 'group_folder_unbind', chat_id: action.chat_id, folder_id: bound.data.id },
    };
  }
  const folder = (await ops.list(action.chat_id)).find((candidate) => candidate.id === action.folder_id);
  if (!folder) throw new Error(`folder ${action.folder_id} is not bound to this group on this device (group_folders lists them)`);
  const unbound = await ops.unbind(folder.id);
  if (!unbound.success) throw new Error(unbound.error.type === 'folder-not-found' ? `folder ${folder.id} not found` : unbound.error.type);
  return { ...row(folder), chat_id: action.chat_id, unbound: true, undo: { tool: 'group_folder_bind', chat_id: action.chat_id, path: folder.path } };
}
