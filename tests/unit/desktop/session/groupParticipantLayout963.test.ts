import { describe, expect, it } from 'vitest';
import { screenLayout } from '@renderer/app/screen-layout';
import { closeScreenBlock } from '@renderer/app/screen-layout-actions';
import { showGroupParticipant } from '@renderer/features/chats/group-participant-actions';
import { chatLayoutOf, openPanelItem, panelTabsOf } from '@renderer/features/chats/chat-tabs/chat-layouts';
const board = { kind: 'kanban.board', title: 'Board' };
const shown = (chatId: string) => chatLayoutOf(chatId).groups.flatMap(({ pane }) => pane.shownTabIds);

describe('a participant beside the group leaves the group\'s own tabs and pairs as they are', () => {
  const participant = (chatId: string) => ({ kind: 'session', projectId: 'p', sessionId: `participant-${chatId}` }) as const;

  it('a folder/App beside the group is kept the same way', () => {
    const chatId = 'participant-folder';
    screenLayout.show({ kind: 'chat', chatId });
    openPanelItem(chatId, board);
    const tab = panelTabsOf(chatId)[0]!.tabId;
    showGroupParticipant(chatId, participant(chatId));
    chatLayoutOf(chatId).setSinglePaneHost(true);
    expect(panelTabsOf(chatId)).toMatchObject([{ tabId: tab, shown: false }]);
    closeScreenBlock(screenLayout.order[1]!);
    chatLayoutOf(chatId).setSinglePaneHost(false);
    expect(panelTabsOf(chatId)).toMatchObject([{ tabId: tab, shown: true }]);
    expect(shown(chatId)).toHaveLength(2);
  });
});
