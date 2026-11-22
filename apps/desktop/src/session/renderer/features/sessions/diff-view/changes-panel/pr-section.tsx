import { messageForUser } from '@/lib/userFacingError';
import { Plus, RefreshCw } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { observer } from 'mobx-react-lite';
import { getPrSyncStore } from '@renderer/features/projects/stores/project-selectors';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { ReadFailedLine } from '@renderer/lib/ui/read-failed-line';
import { Unknown } from '@/components/ui/Unknown';
import { retryOf } from '@/lib/replica';
import { SplitButton, type SplitButtonAction } from '@renderer/lib/ui/split-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { pullRequestErrorMessage } from '@shared/core/pull-requests/pull-requests';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
  useWorkspaceSurface,
} from '../../session-view-context';
import { ChangesViewModeToggle } from './components/changes-view-mode-toggle';
import { CommitRangeCommitsList } from './components/pr-entry/commits-list';
import { PullRequestEntry } from './components/pr-entry/pr-entry';
import { type CommitRange, useCommits } from './components/pr-entry/use-commits';
import { SectionHeader } from './components/section-header';
import { useChangesViewMode } from './hooks/use-changes-view-mode';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export const PullRequestsSection = observer(function PullRequestsSection({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const { translate } = useSessionMessages();
  const { projectId, sessionId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const workspace = useWorkspace();
  const sessionView = useWorkspaceSurface();
  const prStore = sessionView.prStore;
  const repositoryUrl = workspace.gitRepository?.pullRequestRepositoryUrl ?? null;
  const sessionBranch = workspace.gitWorktree.branchName;
  const pullRequests = prStore?.pullRequests ?? [];
  const currentPr = prStore?.currentPr;
  const defaultBranch = workspace.gitRepository?.defaultBranch;
  const headOid = workspace.gitWorktree.headOid;
  const branchCommitRange: CommitRange | undefined =
    !currentPr && defaultBranch?.oid && headOid && defaultBranch.oid !== headOid
      ? {
          source: 'branch',
          baseRefOid: defaultBranch.oid,
          headRefOid: headOid,
        }
      : undefined;
  const branchCommits = useCommits(projectId, workspaceId, branchCommitRange);
  const branchHead = branchCommitRange ? branchCommits.first : undefined;
  const showCreatePrModal = useShowModal('createPrModal');
  const { toast } = useToast();
  const prSyncStore = getPrSyncStore(projectId);

  const hasOpenPr = pullRequests.some((p) => p.status === 'open');
  const isRefreshing = repositoryUrl ? (prSyncStore?.isSyncing(repositoryUrl) ?? false) : false;
  const syncState = repositoryUrl ? prSyncStore?.getState(repositoryUrl) : undefined;
  const syncError = syncState?.status === 'error' ? (syncState.error ?? translate('pr.syncFailed')) : null;

  const onCreatePr =
    sessionBranch && repositoryUrl
      ? () =>
          showCreatePrModal({
            projectId,
            sessionId,
            repositoryUrl: repositoryUrl ?? '',
            branchName: sessionBranch,
            draft: false,
            workspaceId,
            onSuccess: () => {},
          })
      : undefined;

  const onCreateDraftPr =
    sessionBranch && repositoryUrl
      ? () =>
          showCreatePrModal({
            projectId,
            sessionId,
            repositoryUrl: repositoryUrl ?? '',
            branchName: sessionBranch,
            draft: true,
            workspaceId,
            onSuccess: () => {},
          })
      : undefined;

  const prActions: SplitButtonAction[] = [
    { value: 'create-pr', label: translate('pr.create'), action: () => onCreatePr?.() },
    { value: 'create-draft-pr', label: translate('pr.createDraft'), action: () => onCreateDraftPr?.() },
  ];

  const handleRefresh = async () => {
    try {
      const result = await rpc.pullRequests.syncPullRequests(projectId);
      if (!result.success) {
        toast({
          title: translate('pr.refreshFailed'),
          description: messageForUser(pullRequestErrorMessage(result.error)),
          variant: 'destructive',
        });
      }
    } catch (error) {
      toast({
        title: translate('pr.refreshFailed'),
        description: messageForUser(error),
        variant: 'destructive',
      });
    }
  };

  const { mode: viewMode, setMode: setViewMode } = useChangesViewMode('pr');
  const branchUnread = branchHead !== undefined && branchHead.state !== 'value';
  const branchCommitCount = branchHead?.state === 'value' ? branchHead.value.aheadCount : null;
  const showBranchCommits = branchCommitCount !== null && branchCommitCount > 0;
  const sectionLabel = branchHead?.state === 'unknown'
    ? null
    : translate(showBranchCommits || branchHead?.state === 'error' ? 'changes.branchCommits' : 'changes.pullRequests');
  const sectionCount = branchUnread ? null : showBranchCommits ? branchCommitCount : pullRequests.length;
  const createPrTooltip = !repositoryUrl
    ? translate('pr.unavailable')
    : translate(hasOpenPr ? 'pr.alreadyOpen' : 'pr.createHint');

  return (
    <>
      <SectionHeader
        label={sectionLabel}
        count={sectionCount}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        actions={
          <>
            {currentPr && (
              <ChangesViewModeToggle
                value={viewMode}
                onChange={setViewMode}
                label={translate('pr.pullRequestFiles')}
              />
            )}
            <Tooltip>
              <TooltipTrigger>
                <SplitButton
                  variant="outline"
                  size="xs"
                  actions={prActions}
                  disabled={hasOpenPr || !onCreatePr || !onCreateDraftPr}
                  icon={<Plus className="size-3" />}
                />
              </TooltipTrigger>
              <TooltipContent>{createPrTooltip}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button
                  variant="outline"
                  size="icon-xs"
                  onClick={() => void handleRefresh()}
                  disabled={isRefreshing}
                >
                  {isRefreshing ? <LoadingIndicator size="inline" /> : <RefreshCw className="size-3" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{translate('pr.refresh')}</TooltipContent>
            </Tooltip>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {currentPr ? (
          <PullRequestEntry key={currentPr.url} pr={currentPr} />
        ) : branchHead?.state === 'unknown' ? (
          <div className="border-t border-border px-3 py-2">
            <Unknown className="h-[39px] w-full" />
          </div>
        ) : branchHead?.state === 'error' ? (
          <ReadFailedLine
            className="border-t border-border px-3 py-2"
            message={translate('pr.commitsFailed')}
            onRetry={retryOf(branchHead)}
          />
        ) : showBranchCommits && branchCommitRange ? (
          <BranchCommitsEntry range={branchCommitRange} />
        ) : !repositoryUrl ? (
          <EmptyState
            label={translate('pr.unavailable')}
            description={translate('pr.unavailableHint')}
          />
        ) : pullRequests.length === 0 ? (
          <EmptyState
            label={translate(syncError ? 'pr.loadFailed' : 'pr.none')}
            description={syncError ?? translate('pr.noneHint')}
          />
        ) : null}
      </div>
    </>
  );
});

function BranchCommitsEntry({ range }: { range: CommitRange }) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className="min-h-0 flex-1 px-2.5">
        <CommitRangeCommitsList range={range} emptyState={{ label: translate('pr.noCommits'), description: translate('pr.noBranchCommits') }} />
      </div>
    </div>
  );
}
