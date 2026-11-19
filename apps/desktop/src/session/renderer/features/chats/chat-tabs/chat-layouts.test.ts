// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { folderItem, type PanelItem } from './chat-panel-item';
import { askChat, chatAlone, chatBlockContentOf, chatLayoutOf, chatPaneOf, closeChatTab, closeInfoTab, closeTopicTab, focusedChatTab, infoTabOf, memberTopicOf, openInfoTab, openPanelItem, openTopicTab, panelFull, panelTabsOf, revealChatWorkspaceMessage, setPanelFull, showChatOnly, showChatTab, takeChatAsk, topicTabOf, updateFileNames } from './chat-layouts';
import { CHAT_INFO_TAB_KIND, CHAT_PANEL_TAB_KIND, CHAT_TAB_KIND } from './chat-tab-providers';
import { openChatWorkspaceNewTab } from '../../tabs/chat-workspace-new-tab';
import { browserSessionStore } from '../../browser/browser-session-store';
import type { BrowserState } from '../../browser/browser-tab-provider';
import { recentToolPanel, trackRecentTools } from '../../browser/workspace-recent-tools';
import { readViewState } from '@/lib/viewStateTable';
import { tabFullscreen } from '../../tabs/tab-fullscreen';
import { SIDE_PAGE_WIDTH_PX } from '../../tabs/side-width';

const file = (id: string): PanelItem => ({ kind: 'workspace.main', itemId: id, title: `${id}.md`, fileName: `${id}.md` });
const board: PanelItem = { kind: 'kanban.board', title: 'Board' };
const count = (id: string) => chatLayoutOf(id).groups.reduce((sum, { pane }) => sum + pane.tabOrder.length, 0);

describe('chat navigation uses the same page history and real panes as tasks', () => {
  it('reveals a background file beside the pane current now, keeping the current topic in its pane', () => {
    const id = 'background-topic-open';
    const layout = chatLayoutOf(id);
    const main = layout.mainGroup;
    const chat = main.pane.resolvedActiveTabId!;
    openTopicTab(id, { topicChatId: 'background-topic', name: 'Topic' });
    const topic = topicTabOf(id)!.tabId;
    showChatTab(id, topic);
    const output = layout.open(CHAT_PANEL_TAB_KIND, file('background.html'), { from: chat, intent: 'beside', activate: false })!;
    const side = layout.sideGroup!;
    showChatTab(id, output);
    expect(side.pane.resolvedActiveTabId).toBe(topic);
    expect(main.pane.resolvedActiveTabId).toBe(output);
  });
  it('keeps the current topic when a group file opens; choosing another topic only navigates the topic slot', () => {
    const id = 'current-topic-open';
    const layout = chatLayoutOf(id);
    const main = layout.mainGroup;
    openTopicTab(id, { topicChatId: 'topic-a', name: 'A' });
    const topic = topicTabOf(id)!.tabId;
    const side = layout.sideGroup!;
    showChatTab(id, topic);
    openTopicTab(id, { topicChatId: 'topic-b', name: 'B' });
    expect(topicTabOf(id)?.topic.topicChatId).toBe('topic-b');
    expect(side.pane.resolvedActiveTabId).toBe(topic);
    expect(main.pane.activeEntry?.kind).toBe(CHAT_TAB_KIND);
    expect(layout.activePaneId).toBe(side.paneId);
    const html = openPanelItem(id, { kind: null, itemId: 'html', title: 'preview.html', fileName: 'preview.html' })!;
    expect(main.pane.resolvedActiveTabId).toBe(html);
    expect(side.pane.resolvedActiveTabId).toBe(topic);
    expect(topicTabOf(id)?.topic.topicChatId).toBe('topic-b');
    expect(layout.activePaneId).toBe(side.paneId);
  });
  it.each(['dm', 'group'])('keeps the folder context and real layout while browsing in %s', (kind) => {
    const id = `history-${kind}`;
    const layout = chatLayoutOf(id);
    const chat = layout.focusedPane.resolvedActiveTabId!;
    const folder = openPanelItem(id, folderItem(), { from: chat, intent: 'newTab' })!;
    const before = JSON.stringify(layout.layout);
    const pane = chatPaneOf(id, folder)!;
    pane.setPageViewState(folder, { scrollTop: 315, picked: ['config'] });
    expect(openPanelItem(id, file('README'), { from: folder })).toBe(folder);
    expect(count(id)).toBe(2);
    expect(JSON.stringify(layout.layout)).toBe(before);
    expect(panelTabsOf(id).find((tab) => tab.tabId === folder)?.item.itemId).toBe('README');
    pane.go(folder, -1);
    expect(pane.navigationOf(folder)?.pages[0].viewState).toEqual({ scrollTop: 315, picked: ['config'] });
    pane.go(folder, 1);
    expect(panelTabsOf(id).find((tab) => tab.tabId === folder)?.item.itemId).toBe('README');
  });
  it('repeated ordinary private file cards focus one existing tab in a narrow pane', () => {
    const id = 'private-repeat-card'; const layout = chatLayoutOf(id);
    layout.setDimensions(390, 620);
    layout.setSinglePaneHost(true);
    const conversation = layout.focusedPane.resolvedActiveTabId!;
    const first = openPanelItem(id, file('same-file'))!;
    const order = [...layout.focusedPane.tabOrder];
    showChatOnly(id);
    expect(openPanelItem(id, file('same-file'))).toBe(first);
    expect(layout.focusedPane.resolvedActiveTabId).toBe(first);
    expect(layout.focusedPane.tabOrder).toEqual(order);
    // Explicit new-tab remains an explicit request, and another conversation is isolated.
    expect(openPanelItem(id, file('same-file'), { intent: 'newTab', from: conversation })).not.toBe(first);
    expect(openPanelItem('another-private-repeat-card', file('same-file'))).not.toBe(first);
  });
  it('opens from the conversation side by side in the one strip; the next one takes the side, closing it brings A back', () => {
    const id = 'pair-chat'; const layout = chatLayoutOf(id);
    const chat = layout.focusedPane.resolvedActiveTabId!;
    const first = openPanelItem(id, file('A'))!;
    expect(layout.pair).toEqual({ pinned: chat, side: first });
    const second = openPanelItem(id, file('B'))!;
    expect(layout.pair).toEqual({ pinned: chat, side: second });
    expect(layout.groups).toHaveLength(2);
    expect(layout.stripTabIds).toEqual([chat, second, first]);
    closeChatTab(id, second);
    expect(layout.pair).toEqual({ pinned: chat, side: first });
    closeChatTab(id, first);
    expect(layout.groups).toHaveLength(1);
  });
  it('explicit new-tab intent leaves the source content unchanged', () => {
    const id = 'explicit-chat'; const folder = openPanelItem(id, folderItem())!;
    const first = openPanelItem(id, file('README'), { from: folder, intent: 'newTab' })!;
    expect(first).not.toBe(folder);
    expect(panelTabsOf(id).find((tab) => tab.tabId === folder)?.item.itemId).toBeUndefined();
    expect(chatLayoutOf(id).groups.flatMap(({ pane }) => pane.tabOrder)).toEqual(expect.arrayContaining([folder, first]));
  });
  it('closing an inactive page does not change the focused page; closing restores a link once', () => {
    const id = 'close-chat'; let restored = 0;
    const first = openPanelItem(id, board, { restore: () => restored++ })!;
    const next = openPanelItem(id, file('README'), { from: first, intent: 'newTab' })!;
    closeChatTab(id, first);
    expect(focusedChatTab(id)?.tabId).toBe(next);
    closeChatTab(id, first);
    expect(restored).toBe(1);
  });
  it('showing the conversation and fullscreen leave its companion tree intact', () => {
    const id = 'visibility-chat'; const layout = chatLayoutOf(id); const page = openPanelItem(id, board)!;
    const before = JSON.stringify(layout.layout);
    setPanelFull(id, page, true); expect(panelFull(id, page)).toBe(true);
    setPanelFull(id, page, false); expect(tabFullscreen.target).toBeNull();
    showChatOnly(id); expect(focusedChatTab(id)?.kind).toBe('chat');
    showChatTab(id, page); expect(focusedChatTab(id)?.kind).toBe('panel');
    expect(JSON.stringify(layout.layout)).toBe(before);
    expect(chatAlone(id)).toBe(false);
  });
  it('a topic pairs with its group in the group strip; another topic takes its place; closing it leaves the group', () => {
    const id = 'topic-chat'; const layout = chatLayoutOf(id);
    const chat = layout.focusedPane.resolvedActiveTabId!;
    openTopicTab(id, { topicChatId: 'topic-a', name: 'A' });
    const first = topicTabOf(id)!.tabId;
    expect(layout.pair).toEqual({ pinned: chat, side: first });
    openTopicTab(id, { topicChatId: 'topic-b', name: 'B' });
    expect(topicTabOf(id)?.tabId).toBe(first);
    expect(chatPaneOf(id, first)?.navigationOf(first)?.pages).toHaveLength(2);
    closeTopicTab(id);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups.some(({ pane }) => pane.entriesOfKind(CHAT_TAB_KIND).length > 0)).toBe(true);
  });
  it('a file name refresh keeps the same context and does not revive a closed tab', () => {
    const id = 'rename-chat'; const page = openPanelItem(id, file('README'))!;
    updateFileNames([{ id: 'README', filename: 'renamed.md', content_type: 'text/markdown' }], []);
    expect(panelTabsOf(id).find((tab) => tab.tabId === page)?.item.fileName).toBe('renamed.md');
    expect(chatBlockContentOf(id, page)?.itemId).toBe('README');
    closeChatTab(id, page);
    updateFileNames([{ id: 'README', filename: 'later.md', content_type: 'text/markdown' }], []);
    expect(panelTabsOf(id)).toEqual([]);
  });
  it('the members context follows the focused topic, its information page, and the source chat', () => {
    const id = 'topic-members-focus';
    const topic = { topicChatId: 'topic-members', name: 'Topic' };
    openTopicTab(id, topic);
    const topicTab = topicTabOf(id)!.tabId;
    showChatTab(id, topicTab);
    expect(memberTopicOf(id)).toEqual(topic);
    openInfoTab(id, 'members', memberTopicOf(id));
    expect(infoTabOf(id)?.info.topic).toEqual(topic);
    expect(memberTopicOf(id)).toEqual(topic);
    showChatTab(id, topicTab);
    expect(memberTopicOf(id)).toEqual(topic);
    showChatOnly(id);
    expect(memberTopicOf(id)).toBeNull();
    openInfoTab(id);
    expect(infoTabOf(id)?.info.topic).toBeUndefined();
    expect(memberTopicOf(id)).toBeNull();
  });
  it('does not restore a topic members page without its runtime-only topic tab', () => {
    const id = 'topic-members-persistence';
    const topic = { topicChatId: 'transient-topic-id', name: 'Transient topic' };
    openTopicTab(id, topic);
    openInfoTab(id, 'members', topic);
    expect(JSON.stringify(chatLayoutOf(id).snapshot)).not.toContain(topic.topicChatId);
    showChatOnly(id);
    openInfoTab(id, 'members');
    expect(chatLayoutOf(id).snapshot.groups.flatMap((group) => group.tabManager.tabs).some((tab) => tab.kind === 'extension' && tab.extensionKind === CHAT_INFO_TAB_KIND)).toBe(true);
  });
  it('reuses the information tab when switching from source members to topic members', () => {
    const id = 'topic-members-switch';
    openInfoTab(id, 'members');
    const infoTab = infoTabOf(id)!.tabId;
    openTopicTab(id, { topicChatId: 'topic-members-switch', name: 'Topic' });
    showChatTab(id, topicTabOf(id)!.tabId);
    openInfoTab(id, 'members', memberTopicOf(id));
    expect(infoTabOf(id)?.tabId).toBe(infoTab);
    expect(infoTabOf(id)?.info.topic?.topicChatId).toBe('topic-members-switch');
    expect(infoTabOf(id)?.shown).toBe(true);
  });
  it('closing topic members restores the topic on a phone-sized page', () => {
    const id = 'topic-members-phone';
    chatLayoutOf(id).setDimensions(390, 620);
    chatLayoutOf(id).setSinglePaneHost(true);
    openTopicTab(id, { topicChatId: 'topic-members-phone', name: 'Topic' });
    const topicTab = topicTabOf(id)!.tabId;
    openInfoTab(id, 'members', memberTopicOf(id));
    closeInfoTab(id);
    expect(focusedChatTab(id)).toEqual({ tabId: topicTab, kind: 'topic' });
    expect(infoTabOf(id)).toBeNull();
  });
  it('each chat receives only its latest ask once', () => {
    const opener = { chatId: 'asked', itemId: 'README', name: 'README.md', typedName: 'README.md', choice: { kind: 'none' } } as never;
    askChat('asked', { app: 'workspace' }); askChat('asked', { itemId: 'README', opener, from: 'origin' });
    expect(takeChatAsk('asked')).toEqual({ itemId: 'README', opener, from: 'origin' });
    expect(takeChatAsk('asked')).toBeNull();
  });
});

describe('pages beside the chat start at one declared width (side-width.ts, owner 11-07)', () => {
  const sideWidth = (id: string, width: number) => {
    const layout = chatLayoutOf(id);
    const side = layout.groups.find(({ paneId }) => paneId === layout.sidePaneId)!;
    const at = layout.layout.type === 'split' ? layout.layout.children.findIndex((child) => child.type === 'pane' && child.paneId === side.paneId) : -1;
    return Math.round((layout.paneSizes[at] / 100) * width);
  };
  it('the side page width is 360px', () => expect(SIDE_PAGE_WIDTH_PX).toBe(360));
  it.each([1280, 1920, 2560])('group info opens at the side page width beside a %ipx chat, not half', (width) => {
    const id = `side-width-${width}`;
    chatLayoutOf(id).setDimensions(width, 900);
    openInfoTab(id, 'members');
    expect(sideWidth(id, width)).toBe(SIDE_PAGE_WIDTH_PX);
  });
  it('never more than half; a file beside the chat stays its peer', () => {
    chatLayoutOf('side-width-narrow').setDimensions(600, 900);
    openInfoTab('side-width-narrow', 'members');
    expect(sideWidth('side-width-narrow', 600)).toBe(300);
    chatLayoutOf('side-width-file').setDimensions(1600, 900);
    openPanelItem('side-width-file', file('README'));
    expect(chatLayoutOf('side-width-file').paneSizes).toEqual([50, 50]);
  });
  it('a dragged width stays while open; double-click and reopening come back to the declared width', () => {
    const id = 'side-width-drag'; const layout = chatLayoutOf(id);
    layout.setDimensions(2000, 900);
    openInfoTab(id, 'members');
    const cut = layout.layout.type === 'split' ? layout.layout.id : '';
    layout.setSplitSizes(cut, [40, 60]);
    openInfoTab(id, 'announcement');
    expect(layout.paneSizes).toEqual([40, 60]);
    layout.equalizeSplit(cut);
    expect(sideWidth(id, 2000)).toBe(SIDE_PAGE_WIDTH_PX);
    layout.setSplitSizes(cut, [40, 60]);
    closeInfoTab(id);
    expect(infoTabOf(id)).toBeNull();
    openInfoTab(id, 'members');
    expect(sideWidth(id, 2000)).toBe(SIDE_PAGE_WIDTH_PX);
  });
});

describe('chat tool state is scoped to the conversation ID', () => {
  it('uses the same empty, split and hidden transitions in private and group chats', () => {
    for (const id of ['layout-private-chat', 'layout-group-chat']) {
      const layout = chatLayoutOf(id);
      expect(layout.chatToolLayout).toBe('empty');
      const tab = openPanelItem(id, folderItem())!;
      expect(layout.chatToolLayout).toBe('split');
      layout.setChatToolLayout('hidden');
      const extra = openPanelItem(id, file('extra'), { intent: 'newTab' })!;
      expect(layout.chatToolLayout).toBe('hidden');
      closeChatTab(id, extra);
      closeChatTab(id, tab);
      expect(layout.chatToolLayout).toBe('empty');
    }
  });

  it('reveals a selected topic from a hidden group and selects its retained conversation tab from full view', () => {
    const sourceId = 'workspace-source-navigation';
    const topicId = 'workspace-topic-navigation';
    const source = chatLayoutOf(sourceId);
    const topic = chatLayoutOf(topicId);
    const stopSource = source.attachChatWorkspace();
    const stopTopic = topic.attachChatWorkspace();
    try {
      const groupTool = openPanelItem(sourceId, file('group-tool'))!;
      source.setChatToolLayout('hidden');
      openTopicTab(sourceId, { topicChatId: topicId, name: '打开话题' });
      expect(source.chatWorkspaceMode).toBe('split');
      expect(topicTabOf(sourceId)?.shown).toBe(true);
      expect(panelTabsOf(sourceId).map((tab) => tab.tabId)).toEqual([groupTool]);

      const topicTool = openPanelItem(topicId, file('topic-tool'))!;
      const directionAndWidth = topic.layout;
      topic.setChatToolLayout('full');
      revealChatWorkspaceMessage(topicId);
      expect(topic.chatWorkspaceMode).toBe('full');
      expect(topic.activePaneId).toBe(topic.chatWorkspacePanes?.chat.paneId);
      expect(topic.chatWorkspaceSinglePaneId).toBe(topic.chatWorkspacePanes?.chat.paneId);
      expect(topic.layout).toBe(directionAndWidth);
      expect(panelTabsOf(topicId).map((tab) => tab.tabId)).toEqual([topicTool]);
      expect(topicTabOf(sourceId)?.topic.topicChatId).toBe(topicId);
    } finally {
      stopTopic();
      stopSource();
    }
  });

  it('keeps the group, current topic slot and each topic’s own tools independent', () => {
    const sourceId = 'chat-tool-topic-source';
    const topicId = 'chat-tool-topic-1';
    const otherTopicId = 'chat-tool-topic-2';
    openTopicTab(sourceId, { topicChatId: topicId, name: '话题一' });
    const source = chatLayoutOf(sourceId);
    const sourceRoot = source.primaryChatTabId;
    const topicSlot = topicTabOf(sourceId)?.tabId;
    openPanelItem(sourceId, file('source-tool'), { intent: 'newTab' });
    source.setChatToolLayout('full');
    expect(sourceRoot).toBeDefined();
    expect(sourceRoot).not.toBe(topicSlot);

    const topic = chatLayoutOf(topicId);
    expect(topic.chatToolLayout).toBe('empty');
    const topicTool = openPanelItem(topicId, file('topic-tool'))!;
    topic.setChatToolLayout('hidden');
    openTopicTab(sourceId, { topicChatId: otherTopicId, name: '话题二' });
    expect(topicTabOf(sourceId)?.tabId).toBe(topicSlot);
    expect(chatLayoutOf(otherTopicId).chatToolLayout).toBe('empty');
    expect(panelTabsOf(sourceId).map(({ tabId }) => tabId)).not.toContain(topicTool);
    expect(chatLayoutOf(topicId).chatToolLayout).toBe('hidden');
    expect(panelTabsOf(topicId).map(({ tabId }) => tabId)).toEqual([topicTool]);
    expect(viewStateCache.read(`chat:${topicId}:tabs`)).toMatchObject({ chatToolLayout: 'hidden' });
    expect(viewStateCache.read(`chat:${sourceId}:tabs`)).toMatchObject({ chatToolLayout: 'full' });
    expect(JSON.stringify(source.snapshot)).not.toContain(topicTool);
  });
});

it('opens actual new browser tabs independently in a group and topic, retaining a hidden workspace', () => {
  const scope = chatLayoutOf('start-page-test-group');
  const topic = chatLayoutOf('start-page-test-topic');
  const stopScope = scope.attachChatWorkspace();
  const stopTopic = topic.attachChatWorkspace();
  const stopRecent = trackRecentTools(scope);
  try {
    const first = openChatWorkspaceNewTab(scope)!;
    expect(scope.chatWorkspaceMode).toBe('split');
    const tools = scope.chatWorkspacePanes!.tools!.pane;
    const state = tools.entries.get(first)!.state as BrowserState;
    expect(state).toMatchObject({ workspaceStart: true, session: { workspaceId: 'start-page-test-group', sessionId: '', currentUrl: 'about:blank' } });
    browserSessionStore.updateSession(state.browserId, { currentUrl: 'https://example.com/news', title: '测试网页', isLoading: false });
    expect(readViewState(recentToolPanel(tools.ctx))).toMatchObject({ items: [{ kind: 'web', title: '测试网页' }] });

    scope.setChatToolLayout('hidden');
    const second = openChatWorkspaceNewTab(scope)!;
    expect(scope.chatWorkspaceMode).toBe('hidden');
    expect(tools.resolvedActiveTabId).toBe(second);
    expect(tools.tabOrder).toEqual([first, second]);
    expect(openChatWorkspaceNewTab(topic)).toBeTruthy();
    expect(topic.chatWorkspacePanes!.tools!.pane.tabOrder).toHaveLength(1);
    expect(readViewState(recentToolPanel(topic.focusedPane.ctx))).toEqual({});
  } finally {
    stopRecent();
    stopTopic();
    stopScope();
  }
});
