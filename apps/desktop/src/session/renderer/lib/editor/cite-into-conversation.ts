import { useCallback } from 'react';
import type { AnnotationConversation } from '@shared/browser-annotation';
import type { SelectionCite } from '@/components/preview/quote-preview-file';
import { composeChatDraft } from '@/lib/composeDraft';
import { useChatStore } from '@/store/chatContext';
import { findAcpChatStore } from '@renderer/features/sessions/acp/acp-chat-resource-manager';
import { getRendererSession } from '@/lib/sessionPublication';
import { findSessionAnywhere } from '@renderer/features/sessions/stores/session-selectors';
import { composeInSession } from '@renderer/features/extensions/compose-in-session';
import { sessionConversationTabId } from '@renderer/features/sessions/view/session-pane-policy';
import { sessionAnnotations, type SessionAnnotations } from '@renderer/features/sessions/annotations/session-annotations';

/**
 * A selection's Cite on a computer, into the conversation `selectionConversationOf` named: a chat's composer (the words,
 * then the file's pill), or the session's — its conversation tab brought forward, the draft at the end of what is typed.
 */
export async function citeIntoConversation(conversation: AnnotationConversation, cite: SelectionCite): Promise<void> {
  if (conversation.kind === 'chat') {
    composeChatDraft({ chatId: conversation.chatId, text: cite.quote, refs: cite.refs });
    return;
  }
  const view = findSessionAnywhere(conversation.sessionId)?.viewModel;
  if (!view) throw new Error('The task this file belongs to is no longer open');
  const tabId = sessionConversationTabId(view.paneLayout, conversation.sessionId);
  const group = view.paneLayout.groups.find(({ pane }) => tabId && pane.entries.has(tabId));
  if (tabId && group) {
    view.paneLayout.setActiveGroup(group.paneId);
    group.pane.setActiveTab(tabId);
  }
  await composeInSession(view, cite.draft);
}

/** The conversation's annotation draft, as its composer reads it (a chat's is the signed-in account's). */
export function annotationsOf(conversation: AnnotationConversation): SessionAnnotations {
  return sessionAnnotations.forConversation(conversation, getRendererSession()?.user.id);
}

/**
 * A selection's Send: its cite and the person's line after it, sent into the conversation the way typed words go — a chat's
 * outbox, or the session's prompt queue.
 */
export function useSendSelection(): (conversation: AnnotationConversation, cite: SelectionCite, words: string) => Promise<void> {
  const { sendMessageToChat } = useChatStore('sendMessageToChat');
  return useCallback(async (conversation, cite, words) => {
    const body = words ? `${cite.draft}\n\n${words}` : cite.draft;
    if (conversation.kind === 'chat') {
      await sendMessageToChat(conversation.chatId, body);
      return;
    }
    const session = findAcpChatStore(conversation.sessionId);
    if (!session) throw new Error('The task this file belongs to is no longer open');
    await session.submitPrompt(body);
  }, [sendMessageToChat]);
}
