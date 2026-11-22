import { sessionFileChanges } from '@gugu/session-chat-ui';
import { observer } from 'mobx-react-lite';
import { findAcpChatStore } from '@renderer/features/sessions/acp/acp-chat-resource-manager';
import { useSessionViewContext, useWorkspace } from '@renderer/features/sessions/session-view-context';
import { getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { splitPath } from '@renderer/features/sessions/utils';
import { sessionConversationTabId } from '@renderer/features/sessions/view/session-pane-policy';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { formatDiffLineCount } from '@renderer/utils/format-diff-line-count';
import { displayPathForChange } from './components/changes-tree-utils';

/** 不是 git 仓库时审阅页列的东西:本会话「已编辑」卡里的文件(同一个来源,不另读)。点开 = 点卡上那个文件。 */
export const SessionEditedFiles = observer(function SessionEditedFiles({ notRepository }: { notRepository: string }) {
  const { translate } = useSessionMessages();
  const { projectId, sessionId } = useSessionViewContext();
  const workspace = useWorkspace();
  const store = findAcpChatStore(sessionId);
  void store?.transcriptRevision;
  const files = store ? sessionFileChanges(store.chatState.transcript.state.committedTurns) : [];
  const open = (index: number) => {
    const layout = getSessionView(projectId, sessionId)?.paneLayout;
    if (!layout) return;
    const { adds: _adds, dels: _dels, ...change } = files[index]!;
    layout.open('recorded-diff', { ...change, sessionId }, { from: sessionConversationTabId(layout, sessionId), intent: 'beside' });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="text-foreground-muted px-3 py-2 text-xs">
        {/* 对话没载入(页签关着)就只说不是仓库:没读过的轮次 ❌ 说成「没编辑过」。 */}
        {notRepository}{store && ` ${translate(files.length ? 'changes.sessionEditedFiles' : 'changes.noSessionEdits')}`}
        {store?.canLoadOlderHistory && ` ${translate('changes.olderTurnsNotLoaded')}`}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1">
        {files.map((file, index) => {
          const { filename, directory } = splitPath(displayPathForChange(file.path, workspace.path));
          return (
            <button key={file.path} type="button" title={file.path} onClick={() => open(index)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 py-1 hover:bg-row-hover active:bg-row-press">
              <FileIcon filename={filename} size={12} />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="max-w-full shrink-0 truncate text-sm">{filename}</span>
                {directory && <span className="min-w-0 shrink truncate text-xs text-foreground-muted">{directory}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums">
                {!!file.adds && <span className="text-foreground-diff-added">+{formatDiffLineCount(file.adds)}</span>}
                {!!file.dels && <span className="text-foreground-diff-deleted">-{formatDiffLineCount(file.dels)}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});
