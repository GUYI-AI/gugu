import type { Commit } from '@gugu/session-core/git';
import { commitRef } from '@shared/core/git/utils';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import { replica } from '@/lib/replica';
import { useReplicaPages } from '@/lib/replicaPages';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

export const COMMIT_PAGE_SIZE = 50;

export type CommitRangeSource = 'pull-request' | 'branch';

/** The commits between two objects: named by their oids, so what it lists never changes (a new head is a new range). */
export type CommitRange = {
  source: CommitRangeSource;
  baseRefOid: string;
  headRefOid: string;
};

export function commitRangeForPullRequest(pr: PullRequest): CommitRange {
  return {
    source: 'pull-request',
    baseRefOid: pr.baseRefOid,
    headRefOid: pr.headRefOid,
  };
}

/** `next`: the offset of the page after this one, null when this one is the last. */
type CommitPage = { commits: Commit[]; aheadCount: number; next: string | null };

const commitPage = replica({
  name: 'commitPage',
  scope: 'device',
  read: async (_owner, projectId: string, workspaceId: string, baseRefOid: string, headRefOid: string, cursor: string | null): Promise<CommitPage> => {
    const offset = cursor === null ? 0 : Number(cursor);
    const result = await workspaceRpc(projectId).gitWorktree.getLog(
      projectId,
      workspaceId,
      COMMIT_PAGE_SIZE,
      offset,
      undefined,
      undefined,
      commitRef(baseRefOid),
      commitRef(headRefOid)
    );
    if (!result.success) throw new Error('Failed to load commits', { cause: result.error });
    const { commits, aheadCount } = result.data;
    return { commits, aheadCount, next: commits.length === COMMIT_PAGE_SIZE ? String(offset + COMMIT_PAGE_SIZE) : null };
  },
  fresh: Infinity,
  keep: 5 * 60_000,
});

export function useCommits(projectId: string, workspaceId: string, range: CommitRange | undefined) {
  return useReplicaPages(commitPage, range ? [projectId, workspaceId, range.baseRefOid, range.headRefOid] : null, (page) => page.next);
}
