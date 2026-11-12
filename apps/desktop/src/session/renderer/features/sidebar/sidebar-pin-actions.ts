// #2548 固定到左侧栏, the task page's side: what the one list (drawn by the shell) asks of a pinned agent's session.
import { when } from 'mobx';
import { messageForUser } from '@/lib/userFacingError';
import { openChatOnScreen } from '@renderer/features/chats/open-chat';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { toast } from '@renderer/lib/hooks/use-toast';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { innerSidebarChat } from './inner-sidebar-anchor';
import { withMountedSession } from './with-mounted-session';

/** How long the inner column may take to settle on the opened group / project before the agent is selected in it. */
const COLUMN_SETTLE_MS = 5_000;

/** A sidebar session, mounted (its own store) or listed from another machine (its directory row). */
export function sidebarSessionFacts(projectId: string, sessionId: string) {
  const mounted = sessionRegistry.get(sessionId)?.sessions.get(sessionId)?.data;
  if (mounted) {
    return { isPinnedToSidebar: mounted.isPinnedToSidebar === true, archivedAt: mounted.archivedAt ?? null, lastInteractedAt: mounted.lastInteractedAt };
  }
  const listed = sidebarStore.remoteSession(projectId, sessionId)?.summary;
  return { isPinnedToSidebar: listed?.isPinnedToSidebar === true, archivedAt: null, lastInteractedAt: listed?.lastInteractedAt ?? null };
}

/** Is this sidebar session pinned to the sidebar (固定到左侧栏). The inner column's agent rows read it for their mark. */
export function sessionPinnedToSidebar(projectId: string, sessionId: string): boolean {
  return sidebarSessionFacts(projectId, sessionId).isPinnedToSidebar;
}

function sidebarProjectOf(sessionId: string): string {
  const node = sidebarStore.placement.nodeById.get(sessionId);
  if (!node) throw new Error(`Session ${sessionId} pinned to the sidebar is not one of the sidebar's sessions`);
  return node.item.projectId;
}

/**
 * 固定到左侧栏 / 取消固定到左侧栏 (the session menu, the one list's pinned row): one write, on whichever machine the session
 * lives. A refused write (an older host, a child session, a database error) is said, as a failed nest is
 * (set-session-parent-flow): the row only flips back, which by itself says nothing.
 */
export function setPinnedToSidebar(projectId: string, sessionId: string, pinned: boolean): void {
  withMountedSession(projectId, sessionId, (_session, manager) => {
    manager.setSessionPinnedToSidebar(sessionId, pinned).catch((error: unknown) => {
      log.error('Pin to sidebar failed', { sessionId, pinned, error: String(error) });
      toast({
        title: translateSessionMessage(pinned ? 'task.pinToSidebarFailed' : 'task.unpinFromSidebarFailed'),
        description: messageForUser(error),
        variant: 'destructive',
      });
    });
  });
}

/** 取消固定到左侧栏 asked from the one list. */
export function unpinSessionFromSidebar(sessionId: string): void {
  setPinnedToSidebar(sidebarProjectOf(sessionId), sessionId, false);
}

/**
 * A pinned agent's row clicked in the one list: open the group / project it lives in, then select the agent in that
 * group's inner column the way clicking its row there does (open its session; the column stays, the session being one
 * of its agents). The column settles on the group only after the group is shown, so the agent is opened then.
 */
export function openSidebarPin(sessionId: string, homeChatId: string): void {
  const projectId = sidebarProjectOf(sessionId);
  openChatOnScreen(homeChatId, false);
  void when(() => innerSidebarChat.get()?.chatId === homeChatId, { timeout: COLUMN_SETTLE_MS }).then(
    () => {
      appState.navigation.navigate('session', { projectId, sessionId });
      openSessionInSessionWhenReady({ projectId, sessionId });
    },
    (error: unknown) => log.error('The inner column did not open on a pinned agent\'s home', { sessionId, homeChatId, error })
  );
}
