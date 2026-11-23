import { observer } from 'mobx-react-lite';
import { useShownAgentName } from '@/hooks/useShownAgentName';
import { useRowContextMenu } from '@/hooks/useRowContextMenu';
import { ONE_LIST_AVATAR_PX } from '@/lib/sidebarOneList';
import { MenuTableItems } from '@/components/MenuTableItems';
import { Menu } from '@/components/ui/Menu';
import { SessionAvatar } from '@/components/session-watch/StatusGlyph';
import { sessionMenu, type SessionMenuAction } from '@/session/shared/session-menu';
import { copySessionId } from '@renderer/features/sessions/copy-session-id';
import { requestArchiveSession } from '@renderer/features/sessions/archive-session-flow';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { OneListRow } from './project-row-parts';
import { openSidebarSession } from './sidebar-session-item';
import { withMountedSession } from './with-mounted-session';

/**
 * #2548 a top-level task outside every project whose session has no 咕咕 identity (sidebarStore.tasksWithoutAgent): no
 * agent conversation stands for it, so it is drawn as the conversation row it would be (OneListRow) wearing the session's
 * own avatar and status, with its title and when it was last used. A click opens the task as its sidebar row always did;
 * ⌘ click beside. Right click = the session menu (session/shared/session-menu.ts, entry 'one-list-task'): the same
 * rename / archive / copy id, through the same flows, as the task's sidebar row.
 */
export const OneListTaskRow = observer(function OneListTaskRow({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const entry = sidebarStore.placement.nodeById.get(sessionId)?.item;
  const name = useShownAgentName({ name: entry?.title ?? '', createdAt: entry?.createdAt });
  const menu = useRowContextMenu();
  if (!entry) return null;
  const { currentViewId, viewParamsStore } = appState.navigation;
  const open = currentViewId === 'session' && (viewParamsStore.session as { sessionId?: string } | undefined)?.sessionId === sessionId;
  const run: Partial<Record<SessionMenuAction, () => void>> = {
    rename: () => commandRegistry.dispatch('session.rename', { projectId, sessionId }),
    archive: () => withMountedSession(projectId, sessionId, () => requestArchiveSession({ projectId, sessionId })),
    'copy-id': () => void copySessionId(sessionId),
  };
  return (
    <div onContextMenu={menu.onContextMenu}>
      <OneListRow
        leading={<SessionAvatar sessionId={sessionId} presentation={entry.presentation ?? null} size={ONE_LIST_AVATAR_PX} />}
        name={name}
        preview=""
        selected={open}
        onOpen={(beside) => openSidebarSession(projectId, sessionId, beside)}
        data-task-row={sessionId}
      />
      {menu.menuPos ? (
        <Menu x={menu.menuPos.x} y={menu.menuPos.y} onClose={menu.closeMenu}>
          <MenuTableItems
            items={sessionMenu('one-list-task', { pinned: entry.isPinned, sidebarPin: null }, new Set(Object.keys(run) as SessionMenuAction[]))}
            onAction={(id) => { menu.closeMenu(); run[id]!(); }}
            testIdPrefix="one-list-task-menu"
          />
        </Menu>
      ) : null}
    </div>
  );
});
