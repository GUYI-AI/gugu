import type { FolderRecord } from '@shared/core/folders/folders';
import type { LocalProject } from '@shared/projects';
import { receivedCanonicalPath } from '@gugu/session-shared/canonical-path';
import { folderName } from './group-folders-store';

/** A time a folder row has no own record of (an unbound folder has no `attachedAt`): sorts after every dated one. */
const UNDATED = '1970-01-01 00:00:00';

/**
 * A machine's folder as the per-folder store the session page mounts (sessions, git state, settings; keyed by the folder's
 * id, which is what a session's `projectId` carries since C1). A folder bound to no group is a workspace (the task home, an
 * App's directory, a folder unbound from its group): its sessions are tasks in no group.
 */
export function folderAsProject(folder: Pick<FolderRecord, 'id' | 'path' | 'chatId' | 'gitless' | 'baseRef' | 'attachedAt'>): LocalProject {
  const at = folder.attachedAt ? new Date(folder.attachedAt).toISOString().slice(0, 19).replace('T', ' ') : UNDATED;
  return {
    type: 'local',
    id: folder.id,
    name: folderName(folder.path),
    path: receivedCanonicalPath(folder.path),
    // gitless = no base branch; a git folder's base is its own or main (the host answers the real one on mount).
    baseRef: folder.gitless ? null : folder.baseRef ?? 'main',
    repositoryWorkspaceId: folder.id,
    ...(folder.chatId ? {} : { kind: 'workspace' as const }),
    createdAt: at,
    updatedAt: at,
  };
}
