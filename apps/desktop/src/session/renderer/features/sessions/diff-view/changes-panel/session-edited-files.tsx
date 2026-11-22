import { sessionFileChanges } from '@gugu/session-chat-ui';
import { observer } from 'mobx-react-lite';
import { findAcpChatStore } from '@renderer/features/sessions/acp/acp-chat-resource-manager';
import { useSessionViewContext, useWorkspace, useWorkspaceSurface } from '@renderer/features/sessions/session-view-context';
import { workspaceBackend } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { EmptyState } from '@renderer/lib/ui/empty-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { RecordedDiffTabResource } from '../recorded-diff-tab-provider';
import { ChangesListOrTree } from './components/changes-list-or-tree';
import { ChangesViewModeToggle } from './components/changes-view-mode-toggle';
import { SectionHeader } from './components/section-header';
import { useChangesViewMode } from './hooks/use-changes-view-mode';

/**
 * 不是 git 仓库时的审阅页:同一个「已更改」头、同一种行、同一种点开(这一格原地翻到 diff),
 * 列的是本会话「已编辑」卡里的文件(同一个来源,不另读)。git 才有的状态、勾选、暂存、提交这里没有。
 */
export const SessionEditedFiles = observer(function SessionEditedFiles() {
  const { translate } = useSessionMessages();
  const { projectId, sessionId } = useSessionViewContext();
  const surface = useWorkspaceSurface();
  const workspace = useWorkspace();
  const changesView = surface.diffView?.changesView;
  const { mode, setMode } = useChangesViewMode('unstaged');
  const machine = workspaceBackend(projectId).machine;
  const store = findAcpChatStore(sessionId);
  void store?.transcriptRevision;
  if (!changesView) return null;
  // 对话没载入(页签关着)= 不知道:没读过的轮次 ❌ 说成「没编辑过」。
  const files = store
    ? sessionFileChanges(store.chatState.transcript.state.committedTurns)
      .map(file => ({ ...file, additions: file.adds ?? 0, deletions: file.dels ?? 0 }))
    : null;
  const open = (file: NonNullable<typeof files>[number], intent: 'navigate' | 'newTab') => {
    const { adds: _adds, dels: _dels, additions: _additions, deletions: _deletions, ...change } = file;
    surface.activePane.open('recorded-diff', { ...change, sessionId }, { intent });
  };
  const notRepository = machine.kind === 'remote'
    ? translate('remoteWorkspace.notRepository', { device: machine.label() })
    : translate('changes.notRepository');
  const expanded = changesView.expandedSections.unstaged;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        label={translate('changes.changed')}
        count={files?.length ?? null}
        collapsed={!expanded}
        onToggleCollapsed={() => changesView.toggleExpanded('unstaged')}
        actions={<ChangesViewModeToggle value={mode} onChange={setMode} label={translate('changes.changed')} />}
      />
      {expanded && <>
        <div className="text-foreground-muted px-4 pb-2 text-xs">
          {notRepository}{!!files?.length && ` ${translate('changes.sessionEditedFiles')}`}
          {store?.canLoadOlderHistory && ` ${translate('changes.olderTurnsNotLoaded')}`}
        </div>
        {files?.length === 0 && <EmptyState label={translate('changes.noSessionEdits')} />}
        {!!files?.length && <div className="min-h-0 flex-1 px-1">
          <ChangesListOrTree
            viewMode={mode}
            changes={files}
            rootPath={workspace.path}
            activePath={surface.activePane.activeResourceOfKind<RecordedDiffTabResource>('recorded-diff')?.change.path}
            onSelectChange={file => open(file, 'navigate')}
            onDoubleClickChange={file => open(file, 'newTab')}
          />
        </div>}
      </>}
    </div>
  );
});
