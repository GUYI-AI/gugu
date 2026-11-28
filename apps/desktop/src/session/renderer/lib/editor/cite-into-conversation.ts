import type { AnnotationConversation } from '@shared/browser-annotation';
import type { SelectionCite } from '@/components/preview/quote-preview-file';
import { composeChatDraft } from '@/lib/composeDraft';
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
  return sessionAnnotations.forConversation(conversation);
}
