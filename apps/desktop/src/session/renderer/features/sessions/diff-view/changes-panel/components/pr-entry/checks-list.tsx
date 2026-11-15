import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { CheckCircle2, ExternalLink, MinusCircle, XCircle } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import { useSyncCheckRuns } from '@renderer/features/sessions/diff-view/state/use-check-runs';
import { rpc } from '@renderer/lib/ipc';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { MicroLabel } from '@renderer/lib/ui/label';
import {
  computeCheckBucket,
  formatCheckDuration,
  type CheckRun,
  type CheckRunBucket,
} from '@renderer/utils/github';
import { getPrNumber, type PullRequest, type PullRequestComment } from '@shared/core/pull-requests/pull-requests';
import type { Reading } from '@/lib/replica';
import { CommentsList } from './comments-list';
import { buildPullRequestSessionItems, type PullRequestSessionItem } from './pull-request-session';
import { pullRequestComments, usePullRequestComments } from './use-pull-request-comments';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

const NO_COMMENTS: PullRequestComment[] = [];

const bucketOrder: Record<CheckRunBucket, number> = {
  fail: 0,
  pending: 1,
  pass: 2,
  skipping: 3,
  cancel: 4,
};

export function BucketIcon({ bucket }: { bucket: CheckRunBucket }) {
  switch (bucket) {
    case 'pass':
      return <CheckCircle2 className="size-3.5 shrink-0 text-foreground-success" />;
    case 'fail':
      return <XCircle className="size-3.5 shrink-0 text-foreground-destructive" />;
    case 'pending':
      return <LoadingIndicator size="inline" className="shrink-0 text-foreground-warning" />;
    case 'skipping':
    case 'cancel':
      return <MinusCircle className="size-3.5 shrink-0 text-foreground-muted" />;
  }
}

export function CheckRunItem({ check }: { check: CheckRun }) {
  const { translate } = useSessionMessages();
  const bucket = computeCheckBucket(check);
  const duration = formatCheckDuration(
    check.startedAt ?? undefined,
    check.completedAt ?? undefined
  );
  const subtitle = check.appName ?? check.workflowName;
  const detailsUrl = check.detailsUrl;
  return (
    <div className="group relative flex items-center gap-2 rounded-md px-3 py-2 hover:bg-row-hover">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <BucketIcon bucket={bucket} />
          <div className="truncate text-sm">{check.name}</div>
          {check.appLogoUrl ? (
            <img
              src={check.appLogoUrl}
              alt={check.appName ?? ''}
              className="size-4 shrink-0 rounded-sm opacity-60"
            />
          ) : null}
        </div>
        {subtitle && (
          <div className="flex w-full justify-start truncate text-xs text-foreground-passive">
            {subtitle}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {duration && <span className="text-xs text-foreground-passive">{duration}</span>}
        {detailsUrl && (
          <button
            type="button"
            aria-label={translate('pr.openCheckDetails', { name: check.name })}
            className="absolute top-1/2 right-3 hidden -translate-y-1/2 items-center justify-center rounded-sm bg-background-1 px-1 py-0.5 text-foreground-muted group-hover:flex hover:text-foreground"
            onClick={() => void rpc.app.openExternal(detailsUrl)}
          >
            <ExternalLink className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export function ChecksList({ checks }: { checks: CheckRun[] }) {
  const { translate } = useSessionMessages();
  const sorted = useMemo(
    () =>
      [...checks].sort(
        (a, b) => bucketOrder[computeCheckBucket(a)] - bucketOrder[computeCheckBucket(b)]
      ),
    [checks]
  );

  if (sorted.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-foreground-passive">{translate('pr.noChecks')}</div>
    );
  }

  return (
    <div className="flex flex-col gap-[1px]">
      {sorted.map((check, i) => (
        <CheckRunItem key={`${check.name}-${i}`} check={check} />
      ))}
    </div>
  );
}

export const PrChecksList = observer(function PrChecksList({
  projectId,
  pr,
}: {
  projectId: string;
  pr: PullRequest;
}) {
  const { translate } = useSessionMessages();
  const { checks } = useSyncCheckRuns(projectId, pr);
  const comments = usePullRequestComments(projectId, pr);
  // No number on its host = no comments to read: the description alone.
  const sessionItems = useMemo((): Reading<PullRequestSessionItem[]> => {
    if (comments === null) return { state: 'value', value: buildPullRequestSessionItems(pr, NO_COMMENTS), stale: false, error: null };
    if (comments.state !== 'value') return comments;
    return { ...comments, value: buildPullRequestSessionItems(pr, comments.value) };
  }, [pr, comments]);
  const retryComments = () => {
    const prNumber = getPrNumber(pr);
    if (prNumber !== null) void pullRequestComments.refresh(projectId, pr.repositoryUrl, prNumber);
  };

  if (checks.length === 0 && sessionItems.state === 'value' && sessionItems.value.length === 0) {
    return (
      <EmptyState
        label={translate('pr.noChecksOrComments')}
        description={translate('pr.nothingYet')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <section>
        {/* 手搓 caption → 复用共享的 MicroLabel(design.md:一次性字号是 Reject 项,
            这仓已经有 text-xs text-foreground-passive 的角色类了 —— 2026-09-22 改)。 */}
        <MicroLabel className="px-3 pb-1">{translate('pr.checks')}</MicroLabel>
        <ChecksList checks={checks} />
      </section>
      <section>
        <MicroLabel className="px-3 pb-1">{translate('pr.comments')}</MicroLabel>
        <CommentsList comments={sessionItems} onRetry={retryComments} />
      </section>
    </div>
  );
});
