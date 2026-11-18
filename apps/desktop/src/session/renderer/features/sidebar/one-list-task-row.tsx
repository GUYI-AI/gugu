import { observer } from 'mobx-react-lite';
import { useShownAgentName } from '@/hooks/useShownAgentName';
import { formatCalendarDay } from '@/i18n/format';
import { SessionAvatar } from '@/mobile/agent-watch/StatusGlyph';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { OneListRow } from './project-row-parts';
import { openSidebarSession } from './sidebar-session-item';

/**
 * #2548 a top-level task outside every project whose session has no 咕咕 identity (sidebarStore.tasksWithoutAgent): no
 * agent conversation stands for it, so it is drawn as the conversation row it would be (OneListRow) wearing the session's
 * own avatar and status, as a session row without an identity is drawn elsewhere (SessionAvatar), with its title and
 * when it was last used. A click opens the task as its sidebar row always did; ⌘ click beside.
 */
export const OneListTaskRow = observer(function OneListTaskRow({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const entry = sidebarStore.placement.nodeById.get(sessionId)?.item;
  const name = useShownAgentName({ name: entry?.title ?? '', createdAt: entry?.createdAt });
  if (!entry) return null;
  const { currentViewId, viewParamsStore } = appState.navigation;
  const open = currentViewId === 'session' && (viewParamsStore.session as { sessionId?: string } | undefined)?.sessionId === sessionId;
  return (
    <OneListRow
      leading={<SessionAvatar sessionId={sessionId} presentation={entry.presentation ?? null} />}
      name={name}
      time={entry.time ? formatCalendarDay(entry.time) : undefined}
      preview=""
      selected={open}
      onOpen={(beside) => openSidebarSession(projectId, sessionId, beside)}
      data-task-row={sessionId}
    />
  );
});
