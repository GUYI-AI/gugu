import { replica, useReplica, type Reading } from '@/lib/replica';
import { rpc } from '@renderer/lib/ipc';
import {
  getPrNumber,
  pullRequestErrorMessage,
  type PullRequest,
  type PullRequestComment,
} from '@shared/core/pull-requests/pull-requests';

/** A pull request's comments on its host (GitHub): no push, so read again after a while and when the window returns. */
export const pullRequestComments = replica({
  name: 'pullRequestComments',
  scope: 'device',
  read: async (_owner, projectId: string, repositoryUrl: string, prNumber: number): Promise<PullRequestComment[]> => {
    const response = await rpc.pullRequests.getPullRequestComments(projectId, repositoryUrl, prNumber);
    if (!response.success) throw new Error(pullRequestErrorMessage(response.error));
    return response.data.comments;
  },
  fresh: 30_000,
  refreshOnFocus: true,
});

/** The comments of a pull request; `null` = it has no number on its host, so there are no comments to read. */
export function usePullRequestComments(projectId: string, pr: PullRequest): Reading<PullRequestComment[]> | null {
  const prNumber = getPrNumber(pr);
  const reading = useReplica(pullRequestComments, prNumber === null ? null : [projectId, pr.repositoryUrl, prNumber]);
  return prNumber === null ? null : reading;
}
