import { useState } from 'react';
import type { Commit } from '@gugu/session-core/git';
import { commitRef } from '@shared/core/git/utils';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import { replica, useReplicas, type Reading } from '@/lib/replica';
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

type CommitPage = { commits: Commit[]; aheadCount: number };

const commitPage = replica({
  name: 'commitPage',
  scope: 'device',
  read: async (_owner, projectId: string, workspaceId: string, baseRefOid: string, headRefOid: string, offset: number): Promise<CommitPage> => {
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
    return result.data;
  },
  fresh: Infinity,
  keep: 5 * 60_000,
});

export type CommitPages = {
  pages: Reading<CommitPage>[];
  hasMore: boolean;
  loadMore: () => void;
  retry: (index: number) => void;
};

export function useCommits(projectId: string, workspaceId: string, range: CommitRange | undefined): CommitPages {
  const identity = range ? `${range.baseRefOid}:${range.headRefOid}` : null;
  const [shown, setShown] = useState<{ identity: string | null; count: number }>({ identity, count: 1 });
  const count = shown.identity === identity ? shown.count : 1;
  const args = range
    ? Array.from({ length: count }, (_, page) => [projectId, workspaceId, range.baseRefOid, range.headRefOid, page * COMMIT_PAGE_SIZE] as [string, string, string, string, number])
    : [];
  const pages = useReplicas(commitPage, args);
  const last = pages[pages.length - 1];
  return {
    pages,
    hasMore: last?.state === 'value' && last.value.commits.length === COMMIT_PAGE_SIZE,
    loadMore: () => setShown({ identity, count: count + 1 }),
    retry: (index) => {
      const page = args[index];
      if (page) void commitPage.refresh(...page);
    },
  };
}
