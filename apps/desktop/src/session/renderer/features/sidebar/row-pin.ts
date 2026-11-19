import { messageForUser } from '@/lib/userFacingError';
import { agentChatOf, pinChatRow } from '@/lib/chatSummariesBridge';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { toast } from '@renderer/lib/hooks/use-toast';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
/**
 * 置顶 acts on the row this session shows as in the left list (session/shared/session-menu.ts `SessionMenuPin`): a task
 * with a row in a project's list is pinned in that list (the session's pin); a standalone agent's task shows only as its
 * agent's chat-list row (in no group: sidebarStore.groupOfSession = null), so it is pinned among the conversations (the chat's pin).
 * Every session menu reads it here, so 置顶 in the tab and in the chat list are one state.
 */
export type RowPin = { pinned: boolean; setPinned: (pinned: boolean) => void };
/** Which row 置顶 acts on. A chat-list row is already a row of the left list: 固定到左侧栏 has nothing to add there. */
export type RowPinned = RowPin & { row: 'session' | 'chat' };

/** `session` = the session's own pin and how the caller writes it (its store), used when the row is the session's. */
export function rowPinOf(projectId: string, sessionId: string, session: RowPin): RowPinned {
  const agentUserId = sessionAgentBindings.bindingFor(sessionId)?.agentUserId;
  const chat = agentUserId && sidebarStore.groupOfSession(sessionId) === null ? agentChatOf(agentUserId) : null;
  if (chat) {
    return {
      row: 'chat',
      pinned: chat.summary.pinned === true,
      setPinned: (pinned) => void pinChatRow(chat.chatId, pinned).catch((error: unknown) => {
        log.error('[session-menu] pin chat row failed', { sessionId, chatId: chat.chatId, error: String(error) });
        toast({ title: translateSessionMessage('task.pinFailed'), description: messageForUser(error), variant: 'destructive' });
      }),
    };
  }
  return { ...session, row: 'session' };
}
