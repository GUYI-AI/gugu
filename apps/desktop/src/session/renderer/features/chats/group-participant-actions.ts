import type { ScreenBlockContent } from '@renderer/app/screen-layout';
import { screenLayout } from '@renderer/app/screen-layout';
import { auxWindows } from '@renderer/app/aux-windows';
import { returnToScreen } from '@renderer/app/screen-layout-actions';
import { showChatOnly } from './chat-tabs/chat-layouts';
import { groupParticipantPanes } from './group-participant-panes';

/** The block a chat is on this screen as. Not on screen = undefined. */
export function chatBlockOnScreen(chatId: string): ScreenBlockContent | undefined {
  for (const id of screenLayout.order) {
    const content = screenLayout.blocks.get(id);
    if (content?.kind === 'chat' && content.chatId === chatId) return content;
  }
}

function sourceContent(chatId: string): ScreenBlockContent {
  return chatBlockOnScreen(chatId) ?? { kind: 'chat', chatId };
}

/** Commit only once a real workspace exists; nothing navigates away from the group while it is loading. */
export function showGroupParticipant(sourceChatId: string, target: ScreenBlockContent): void {
  const source = sourceContent(sourceChatId);
  const sourceId = screenLayout.blockOf(source);
  if (!sourceId) return;
  const windowed = target.kind === 'session' ? auxWindows.windowOfSession(target.sessionId) : undefined;
  if (windowed) {
    windowed.handle?.focus();
    return;
  }
  const previous = groupParticipantPanes.placements.get(sourceChatId);
  if (!previous && !screenLayout.canPlaceAt(target, sourceId)) throw new Error('No room to open this conversation beside the group');
  const blockElement = (id: string | undefined) => id && typeof document !== 'undefined'
    ? document.querySelector<HTMLElement>(`[data-screen-block="${id}"]`) : null;
  const extent = (blockElement(sourceId)?.getBoundingClientRect().width ?? 0)
    + (previous ? blockElement(screenLayout.blockOf(previous.target))?.getBoundingClientRect().width ?? 0 : 0);
  if (!groupParticipantPanes.show(sourceChatId, source, target, extent)) throw new Error('No room to open this conversation beside the group');
  // The group's own tabs and pairs stay as they are; narrower now, the block draws what fits, the chat first.
  showChatOnly(sourceChatId);
  returnToScreen();
}
