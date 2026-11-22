import type { GitChange } from '@gugu/session-core/git';
import { replica } from '@/lib/replica';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

/** A commit never changes: read once, kept a while after it is folded. */
export const commitFiles = replica({
  name: 'commitFiles',
  scope: 'device',
  read: async (_owner, projectId: string, workspaceId: string, commitHash: string): Promise<GitChange[]> => {
    const result = await workspaceRpc(projectId).gitWorktree.getCommitFiles(workspaceId, commitHash);
    if (!result.success) throw new Error('Failed to load commit files', { cause: result.error });
    return result.data.files;
  },
  fresh: Infinity,
  keep: 5 * 60_000,
});
