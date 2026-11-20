// @@@group-folders — where a new session lives and works: {group, workspace}. One rule for every creation path (a new
// task from the session page or a phone, `session_spawn` here or from another machine, an App's spawnAgent):
//   - the group: the one named; null = no group (the task home);
//   - the workspace: the one named (a folder recorded here, or a workspace inside one), else the directory named by
//     `cwd` (recorded as a folder when it is not yet), else the group's first folder on this machine, else the task
//     home — said in `note`, so the caller knows the session did not start where the group's work is.
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { canonicalPath } from '@gugu/session-core/files';
import { ensureFolder, ensureTaskHomeFolder, isTaskHomeFolder, listFolders, rootFolderOf } from '@main/core/folders/folders';
import { checkIsValidDirectory } from '@main/core/utils/directory-status';

export type SessionPlacement = { groupChatId: string | null; workspaceId: string; note?: string };

export class PlacementError extends Error {
  constructor(readonly code: 'folder_not_found' | 'folder_not_in_group' | 'cwd_invalid', message: string) {
    super(message);
  }
}

export function resolveSessionPlacement(input: {
  groupChatId: string | null;
  workspaceId?: string;
  cwd?: string;
}): SessionPlacement {
  const { groupChatId } = input;
  if (input.workspaceId) {
    const folder = rootFolderOf(input.workspaceId);
    if (!folder) throw new PlacementError('folder_not_found', `workspace ${input.workspaceId} is not a folder on this machine`);
    // The task home is bound to no group: a group with no folder here runs its tasks in it (Q5).
    if (groupChatId !== null && folder.chatId !== groupChatId && !isTaskHomeFolder(folder.id)) {
      throw new PlacementError('folder_not_in_group', `folder ${folder.path} is not bound to group ${groupChatId} on this machine`);
    }
    return { groupChatId, workspaceId: input.workspaceId };
  }
  const cwd = input.cwd?.trim();
  if (cwd) {
    const target = expandHome(cwd);
    if (!isAbsolute(target)) throw new PlacementError('cwd_invalid', `cwd must be an absolute path: ${cwd}`);
    if (!checkIsValidDirectory(target)) throw new PlacementError('cwd_invalid', `cwd is not a directory on this machine: ${cwd}`);
    return { groupChatId, workspaceId: ensureFolder(canonicalPath(target)).id };
  }
  if (groupChatId === null) return { groupChatId, workspaceId: ensureTaskHomeFolder().id };
  const first = listFolders(groupChatId)[0];
  if (first) return { groupChatId, workspaceId: first.id };
  return {
    groupChatId,
    workspaceId: ensureTaskHomeFolder().id,
    note: `This machine has no folder bound to group ${groupChatId}; the session started in the task home. Bind one with group_folder_bind to work in it.`,
  };
}

/** `~` / `~/x` → this machine's home directory (a path from another machine is read on this one). */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
