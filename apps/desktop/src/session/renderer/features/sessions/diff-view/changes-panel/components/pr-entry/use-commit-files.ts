import type { GitChange } from '@gugu/session-core/git';
import { replica, useReplica, type Reading } from '@/lib/replica';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

/** The files a commit changed: a commit never changes, so it is read once and kept a while after it is folded. */
export const commitFiles = replica({
  name: 'commitFiles',
  scope: 'device',
  read: async (_owner, projectId: string, workspaceId: string, commitHash: string): Promise<GitChange[]> => {
    const result = await workspaceRpc(projectId).gitWorktree.getCommitFiles(projectId, workspaceId, commitHash);
    if (!result.success) throw new Error('Failed to load commit files', { cause: result.error });
    return result.data.files;
  },
  fresh: Infinity,
  keep: 5 * 60_000,
});

export function useCommitFiles(projectId: string, workspaceId: string, commitHash: string): Reading<GitChange[]> {
  return useReplica(commitFiles, [projectId, workspaceId, commitHash]);
}
