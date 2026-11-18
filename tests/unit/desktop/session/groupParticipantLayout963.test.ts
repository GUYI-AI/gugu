import { describe, expect, it } from 'vitest';
import { screenLayout } from '@renderer/app/screen-layout';
import { closeScreenBlock } from '@renderer/app/screen-layout-actions';
import { showGroupParticipant } from '@renderer/features/chats/group-participant-actions';
import { groupParticipantPanes } from '@renderer/features/chats/group-participant-panes';
import { chatLayoutOf, focusedChatTab, openPanelItem, openTopicTab, panelTabsOf, showChatTab, topicTabOf } from '@renderer/features/chats/chat-tabs/chat-layouts';
const board = { kind: 'kanban.board', title: 'Board' };
const shown = (chatId: string) => chatLayoutOf(chatId).groups.flatMap(({ pane }) => pane.shownTabIds);

describe('a participant beside the group leaves the group\'s own tabs and pairs as they are', () => {
  const participant = (chatId: string) => ({ kind: 'session', projectId: 'p', sessionId: `participant-${chatId}` }) as const;
  const withTopic = (chatId: string) => {
    screenLayout.show({ kind: 'chat', chatId });
    openTopicTab(chatId, { topicChatId: 'topic', name: 'Topic' });
    return topicTabOf(chatId)!.tabId;
  };

  it('with room for all three, the topic stays beside the group and looking at it closes nothing', () => {
    const chatId = 'participant-wide';
    const topicId = withTopic(chatId);
    const before = JSON.stringify(chatLayoutOf(chatId).layout);
    showGroupParticipant(chatId, participant(chatId));
    expect(screenLayout.order).toHaveLength(2);
    expect(topicTabOf(chatId)).toMatchObject({ tabId: topicId, shown: true });
    expect(shown(chatId)).toHaveLength(2);
    showChatTab(chatId, topicId);
    expect(screenLayout.order).toHaveLength(2);
    expect(JSON.stringify(chatLayoutOf(chatId).layout)).toBe(before);
  });

  it.each([
    ['its block is closed', () => closeScreenBlock(screenLayout.order[1]!)],
    ['it is put away', (chatId: string) => { groupParticipantPanes.hide(chatId); }],
    ['its block leaves the screen', () => { screenLayout.close(screenLayout.order[1]!); }],
  ])('too narrow for the topic, only the chat is drawn; the topic is back once the participant leaves: %s', (how, leave) => {
    const chatId = `participant-leaves-${how}`;
    const topicId = withTopic(chatId);
    const layout = chatLayoutOf(chatId);
    const before = JSON.stringify(layout.snapshot);
    showGroupParticipant(chatId, participant(chatId));
    // What the block's tree does once the participant has taken its width (pane-tree-view measures it).
    layout.setNarrow(true);
    expect(focusedChatTab(chatId)?.kind).toBe('chat');
    expect(topicTabOf(chatId)).toMatchObject({ tabId: topicId, shown: false });
    expect(JSON.stringify(layout.snapshot)).toBe(before);
    leave(chatId);
    layout.setNarrow(false);
    expect(screenLayout.order).toHaveLength(1);
    expect(topicTabOf(chatId)).toMatchObject({ tabId: topicId, shown: true });
    expect(layout.pair?.side).toBe(topicId);
    expect(JSON.stringify(layout.snapshot)).toBe(before);
  });

  it('too narrow for both, asking for the topic takes the width back from the participant', () => {
    const chatId = 'participant-topic';
    const topicId = withTopic(chatId);
    showGroupParticipant(chatId, participant(chatId));
    chatLayoutOf(chatId).setNarrow(true);
    showChatTab(chatId, topicId);
    expect(screenLayout.order).toHaveLength(1);
    expect(groupParticipantPanes.placements.has(chatId)).toBe(false);
    chatLayoutOf(chatId).setNarrow(false);
    expect(topicTabOf(chatId)).toMatchObject({ tabId: topicId, shown: true });
    expect(shown(chatId)).toHaveLength(2);
  });

  it('no room for the participant changes nothing in the group', () => {
    const chatId = 'participant-no-room';
    const topicId = withTopic(chatId);
    const canPlaceAt = screenLayout.canPlaceAt;
    screenLayout.canPlaceAt = () => false;
    try {
      expect(() => showGroupParticipant(chatId, participant(chatId))).toThrow();
    } finally { screenLayout.canPlaceAt = canPlaceAt; }
    expect(topicTabOf(chatId)).toMatchObject({ tabId: topicId, shown: true });
    expect(focusedChatTab(chatId)?.kind).toBe('topic');
  });

  it('a folder/App beside the group is kept the same way', () => {
    const chatId = 'participant-folder';
    screenLayout.show({ kind: 'chat', chatId });
    openPanelItem(chatId, board);
    const tab = panelTabsOf(chatId)[0]!.tabId;
    showGroupParticipant(chatId, participant(chatId));
    chatLayoutOf(chatId).setNarrow(true);
    expect(panelTabsOf(chatId)).toMatchObject([{ tabId: tab, shown: false }]);
    closeScreenBlock(screenLayout.order[1]!);
    chatLayoutOf(chatId).setNarrow(false);
    expect(panelTabsOf(chatId)).toMatchObject([{ tabId: tab, shown: true }]);
    expect(shown(chatId)).toHaveLength(2);
  });
});
