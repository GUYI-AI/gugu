import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useSessionViewContext, useWorkspace, useWorkspaceId, useWorkspaceSurface } from '@renderer/features/sessions/session-view-context';
import { nudgeWorkspace } from '@renderer/features/sessions/stores/workspace-nudges';
import { Button } from '@renderer/lib/ui/button';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { TrackCut } from '@renderer/features/tabs/pane-track-cut';
import type { ExpandedSections } from '@renderer/features/sessions/diff-view/stores/changes-view-store';
import { GitStatusSection } from './git-status-section';
import { PullRequestsSection } from './pr-section';
import { SessionEditedFiles } from './session-edited-files';
import { StagedSection } from './staged-section';
import { UnstagedSection } from './unstaged-section';

const ALL_EXPANDED: ExpandedSections = { unstaged: true, staged: true, pullRequests: true };
/** A folded section is its header (SectionHeader: py-2 around a p-2 button with a size-4 icon). */
const SECTION_HEADER_PX = 40;
const SECTION_MIN_PX = 150;
const SECTIONS = ['unstaged', 'staged', 'pullRequests'] as const;

/** A folded section takes its header, the open ones share the rest evenly; with all folded the rest is the spacer's. */
export function sectionShares(expanded: ExpandedSections, span: number): number[] {
  const header = span > 0 ? (SECTION_HEADER_PX / span) * 100 : 0;
  const open = SECTIONS.filter((key) => expanded[key]).length;
  const rest = 100 - header * (SECTIONS.length - open);
  return [...SECTIONS.map((key) => (expanded[key] ? rest / open : header)), open ? 0 : rest];
}

const Section = ({ children }: { children: React.ReactNode }) => <div className="flex h-full flex-col overflow-hidden">{children}</div>;

export const ChangesPanel = observer(function ChangesPanel({ isVisible }: { isVisible?: boolean }) {
  const sessionView = useWorkspaceSurface();
  const workspace = useWorkspace();
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const diffView = sessionView.diffView;
  const changesView = diffView?.changesView;
  const shown = isVisible ?? sessionView.isChangesPanelVisible;

  // 改动面板切到眼前:让这个工作区的 git status 重算一次(一个目录一个 watch 的平台上,没人盯着的目录里的改动靠这一下)。
  useEffect(() => {
    if (shown) void nudgeWorkspace(projectId, workspaceId);
  }, [shown, projectId, workspaceId]);

  const expanded = changesView?.expandedSections ?? ALL_EXPANDED;
  // Where the person dragged the dividers to, until a section opens or folds (then the open ones share the room again).
  const [dragged, setDragged] = useState<{ for: ExpandedSections; shares: number[] } | null>(null);
  const shares = dragged?.for === expanded ? dragged.shares : (span: number) => sectionShares(expanded, span);

  if (!diffView || !changesView) return null;
  // 不是 git 仓库:同一张审阅页,来源换成本会话「已编辑」卡,git 才有的部分不画。
  if (!sessionView.unreachableLabel && workspace.gitWorktree.problem?.kind === 'not-repository') return <SessionEditedFiles />;
  if (sessionView.unreachableLabel || !workspace.gitWorktree.hasData || workspace.gitWorktree.problem) {
    return <ChangesPanelState />;
  }

  return (
    <div className="flex h-full flex-col">
      <TrackCut
        axis="y"
        shares={shares}
        items={[
          { id: 'unstaged', min: expanded.unstaged ? SECTION_MIN_PX : SECTION_HEADER_PX, fixed: !expanded.unstaged, node: <Section><UnstagedSection /></Section> },
          { id: 'staged', min: expanded.staged ? SECTION_MIN_PX : SECTION_HEADER_PX, fixed: !expanded.staged, node: <Section><StagedSection /></Section> },
          {
            id: 'pullRequests',
            min: expanded.pullRequests ? SECTION_MIN_PX : SECTION_HEADER_PX,
            fixed: !expanded.pullRequests,
            node: <Section><PullRequestsSection onToggleCollapsed={() => changesView.toggleExpanded('pullRequests')} collapsed={!expanded.pullRequests} /></Section>,
          },
          // The room no open section takes (all folded): an empty fill under the headers.
          { id: 'spacer', min: 0, fixed: true, node: null },
        ]}
        animate
        onShares={(next) => setDragged({ for: expanded, shares: next })}
        onEqualize={() => setDragged(null)}
      />
      <GitStatusSection />
    </div>
  );
});

/** 画不出改动清单时的那一格:那台机器离线 / 还在读 / 改动太多 / 读失败(可重试)。❌ 空白一片。 */
const ChangesPanelState = observer(function ChangesPanelState() {
  const { translate } = useSessionMessages();
  const surface = useWorkspaceSurface();
  const git = useWorkspace().gitWorktree;
  const problem = git.problem;
  if (surface.unreachableLabel) return <EmptyState label={surface.unreachableLabel} />;
  if (problem?.kind === 'too-many-files') return <EmptyState label={translate('changes.tooManyChanges')} />;
  if (problem?.kind === 'failed') {
    return (
      <EmptyState
        label={problem.message || translate('changes.loadFailed')}
        action={
          <Button size="xs" variant="outline" onClick={() => void git.resync()}>
            {translate('workspace.retry')}
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex h-full items-center justify-center">
      <LoadingIndicator ariaLabel={translate('task.loading')} label={translate('task.loading')} />
    </div>
  );
});
