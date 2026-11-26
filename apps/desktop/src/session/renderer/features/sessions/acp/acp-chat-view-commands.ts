import type { ChatView, ChatViewCommandId } from '@renderer/lib/chat/chat-transcript';

/** A text field the user is typing in: its arrows are the caret's, not the transcript's. */
export function isEditableElement(element: Element | null): boolean {
  return !!element?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
}

export function executeChatViewCommand(
  view: ChatView | null,
  commandId: ChatViewCommandId
): boolean {
  if (!view) return false;

  switch (commandId) {
    case 'chat.scrollToTop':
      view.scrollToTop({ behavior: 'smooth' });
      return true;
    case 'chat.scrollToBottom':
      view.scrollToBottom({ behavior: 'smooth' });
      return true;
  }
}
