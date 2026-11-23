// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { folderItem, type PanelItem } from './chat-panel-item';
import { askChat, chatAlone, chatBlockContentOf, chatTabShown, chatLayoutOf, chatPaneOf, closeChatTab, closeInfoTab, focusedChatTab, infoTabOf, openInfoTab, openPanelItem, panelFull, panelTabsOf, setPanelFull, showChatOnly, showChatTab, takeChatAsk, updateFileNames } from './chat-layouts';
import { openChatWorkspaceNewTab } from '../../tabs/chat-workspace-new-tab';
import { browserSessionStore } from '../../browser/browser-session-store';
import type { BrowserState } from '../../browser/browser-tab-provider';
import { recentToolPanel, trackRecentTools } from '../../browser/workspace-recent-tools';
import { readViewState } from '@/lib/viewStateTable';
import { tabFullscreen } from '../../tabs/tab-fullscreen';

const file = (id: string): PanelItem => ({ kind: 'workspace.main', itemId: id, title: `${id}.md`, fileName: `${id}.md` });
const board: PanelItem = { kind: 'kanban.board', title: 'Board' };
const count = (id: string) => chatLayoutOf(id).groups.reduce((sum, { pane }) => sum + pane.tabOrder.length, 0);

describe('chat navigation uses the same page history and real panes as tasks', () => {
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
  it('a page in front of the conversation in a narrow strip hides it; showing the chat brings its tab back', () => {
    const id = 'narrow-cite-target'; const layout = chatLayoutOf(id);
    layout.setDimensions(390, 620);
    layout.setSinglePaneHost(true);
    expect(chatTabShown(id)).toBe(true);
    openPanelItem(id, file('cited'));
    expect(chatTabShown(id)).toBe(false);
    showChatOnly(id);
    expect(chatTabShown(id)).toBe(true);
  });
  it('a page beside the conversation leaves its tab shown', () => {
    const id = 'pair-cite-target';
    openPanelItem(id, file('beside'));
    expect(chatTabShown(id)).toBe(true);
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
  it('a file name refresh keeps the same context and does not revive a closed tab', () => {
    const id = 'rename-chat'; const page = openPanelItem(id, file('README'))!;
    updateFileNames([{ id: 'README', filename: 'renamed.md', content_type: 'text/markdown' }], []);
    expect(panelTabsOf(id).find((tab) => tab.tabId === page)?.item.fileName).toBe('renamed.md');
    expect(chatBlockContentOf(id, page)?.itemId).toBe('README');
    closeChatTab(id, page);
    updateFileNames([{ id: 'README', filename: 'later.md', content_type: 'text/markdown' }], []);
    expect(panelTabsOf(id)).toEqual([]);
  });
  it('each chat receives only its latest ask once', () => {
    const opener = { chatId: 'asked', itemId: 'README', name: 'README.md', typedName: 'README.md', choice: { kind: 'none' } } as never;
    askChat('asked', { app: 'workspace' }); askChat('asked', { itemId: 'README', opener, from: 'origin' });
    expect(takeChatAsk('asked')).toEqual({ itemId: 'README', opener, from: 'origin' });
    expect(takeChatAsk('asked')).toBeNull();
  });
});

describe('a chat\'s Details open as the right card\'s peer: half each (界面减法, design S.frac = .5)', () => {
  const sideWidth = (id: string, width: number) => {
    const layout = chatLayoutOf(id);
    const side = layout.groups.find(({ paneId }) => paneId === layout.sidePaneId)!;
    const at = layout.layout.type === 'split' ? layout.layout.children.findIndex((child) => child.type === 'pane' && child.paneId === side.paneId) : -1;
    return Math.round((layout.paneSizes[at] / 100) * width);
  };
  it.each([600, 1280, 1920, 2560])('group info opens at half beside a %ipx chat', (width) => {
    const id = `side-width-${width}`;
    chatLayoutOf(id).setDimensions(width, 900);
    openInfoTab(id, 'members');
    expect(sideWidth(id, width)).toBe(width / 2);
  });
  it('a file beside the chat is its peer too', () => {
    chatLayoutOf('side-width-file').setDimensions(1600, 900);
    openPanelItem('side-width-file', file('README'));
    expect(chatLayoutOf('side-width-file').paneSizes).toEqual([50, 50]);
  });
  it('a dragged width stays while open; double-click and reopening come back to half', () => {
    const id = 'side-width-drag'; const layout = chatLayoutOf(id);
    layout.setDimensions(2000, 900);
    openInfoTab(id, 'members');
    const cut = layout.layout.type === 'split' ? layout.layout.id : '';
    layout.setSplitSizes(cut, [40, 60]);
    openInfoTab(id, 'announcement');
    expect(layout.paneSizes).toEqual([40, 60]);
    layout.equalizeSplit(cut);
    expect(sideWidth(id, 2000)).toBe(1000);
    layout.setSplitSizes(cut, [40, 60]);
    closeInfoTab(id);
    expect(infoTabOf(id)).toBeNull();
    openInfoTab(id, 'members');
    expect(sideWidth(id, 2000)).toBe(1000);
  });
});

describe('chat tool state is scoped to the conversation ID', () => {
  it('reveals explicitly opened files in mounted private and group chats', () => {
    for (const id of ['layout-private-chat', 'layout-group-chat']) {
      const layout = chatLayoutOf(id);
      const detach = layout.attachChatWorkspace();
      try {
        expect(layout.chatToolLayout).toBe('empty');
        const tab = openPanelItem(id, folderItem())!;
        expect(layout.chatToolLayout).toBe('split');
        layout.setChatToolLayout('hidden');
        const extra = openPanelItem(id, file('extra'), { intent: 'newTab' })!;
        expect(layout.chatToolLayout).toBe('split');
        expect(layout.focusedPane.resolvedActiveTabId).toBe(extra);
        expect(panelTabsOf(id).find((page) => page.tabId === extra)?.shown).toBe(true);
        closeChatTab(id, extra);
        closeChatTab(id, tab);
        expect(layout.chatToolLayout).toBe('empty');
      } finally { detach(); }
    }
  });


});

it('opens actual new browser tabs independently and reveals the explicitly selected group workspace', () => {
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
    expect(scope.chatWorkspaceMode).toBe('split');
    expect(scope.activePaneId).toBe(scope.chatWorkspacePanes!.tools!.paneId);
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
