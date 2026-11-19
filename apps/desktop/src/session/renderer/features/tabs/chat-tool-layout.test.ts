import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { chatDividerAt, chatToolDropId } from './chat-tool-geometry';
import { PaneLayoutStore } from './pane-layout-store';

const provider = (kind: string) => createTabProvider({
  kind,
  conversation: kind === 'chat',
  resourceKey: (state: { id: string }) => state.id,
  initialize: () => ({ dispose() {} }),
  dispose() {},
  ...(kind === 'preview' ? { isPersistent: () => false } : {}),
  TabBarItem: () => null,
  TabBarItemDragPreview: () => null,
  TabContent: () => null,
});

const registry = createTabRegistry(['chat', 'tool', 'preview'].map(provider));
const layouts: PaneLayoutStore[] = [];
const newTab = { from: null, intent: 'newTab' } as const;

function makeLayout(owner?: string) {
  const layout = new PaneLayoutStore(registry, { viewId: owner ?? 'plain-tabs' }, undefined, {
    isPrimaryChatTab: owner
      ? (entry) => entry.kind === 'chat' && (entry.state as { id: string }).id === owner
      : undefined,
    placementMemory: { read: () => undefined, write() {} },
  });
  layouts.push(layout);
  return layout;
}

afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

describe('chat and tool layout', () => {
  it('keeps the same conversation as a tab before the floating control and switches without restoring a split', () => {
    const layout = makeLayout('owner');
    const owner = layout.open('chat', { id: 'owner' }, newTab)!;
    const tool = layout.open('tool', { id: 'one' }, newTab)!;
    const detach = layout.attachChatWorkspace();
    try {
      const panes = layout.chatWorkspacePanes!;
      layout.setDimensions(900, 600);
      expect(layout.chatWorkspaceConversationPresentation).toBe('pane');
      layout.collapseChatToolSide(layout.chatToolSide === 'right' ? 'left' : 'right');
      expect(layout.chatWorkspaceConversationPresentation).toBe('tab');
      const tree = layout.layout;
      layout.setDimensions(380, 600);
      expect(layout.chatWorkspaceConversationPresentation).toBe('bubble');
      layout.showChatWorkspaceConversation();
      expect(layout.chatWorkspaceSinglePaneId).toBe(panes.chat.paneId);
      expect(layout.chatWorkspaceMode).toBe('full');
      expect(layout.chatWorkspaceConversationPresentation).toBe('tab');
      panes.tools!.pane.setActiveTab(tool);
      expect(layout.chatWorkspaceSinglePaneId).toBe(panes.tools!.paneId);
      expect(layout.layout).toBe(tree);
      expect(panes.chat.pane.tabOrder).toEqual([owner]);
    } finally { detach(); }
  });
  it('splits when the first tool opens, keeps a chosen mode, and resets after the last tool closes', () => {
    const layout = makeLayout('owner');
    const owner = layout.open('chat', { id: 'owner' }, newTab)!;
    expect(layout.primaryChatTabId).toBe(owner);
    expect(layout.chatToolLayout).toBe('empty');
    expect(layout.snapshot.chatToolLayout).toBeUndefined();

    const first = layout.open('tool', { id: 'one' }, newTab)!;
    expect(layout.chatToolLayout).toBe('split');
    layout.setChatToolLayout('hidden');
    const second = layout.open('tool', { id: 'two' }, newTab)!;
    expect(layout.chatToolLayout).toBe('hidden');
    expect(layout.stripTabIds).toEqual([owner, first, second]);

    layout.setChatToolLayout('full');
    layout.open('tool', { id: 'two' }, { from: null, intent: 'navigate' });
    expect(layout.chatToolLayout).toBe('full');
    layout.focusedPane.closeTab(second);
    expect(layout.chatToolLayout).toBe('full');
    layout.focusedPane.closeTab(first);
    expect(layout.chatToolLayout).toBe('empty');

    layout.open('tool', { id: 'three' }, newTab);
    expect(layout.chatToolLayout).toBe('split');
  });

  it.each(['full', 'hidden'] as const)('restores %s with the same left/right geometry, order and active tab', (mode) => {
    const layout = makeLayout('owner');
    const owner = layout.open('chat', { id: 'owner' }, newTab)!;
    const tool = layout.open('tool', { id: 'one' }, newTab)!;
    layout.splitPane(layout.activePaneId, 'left', tool);
    const cut = layout.layout;
    if (cut.type !== 'split') throw new Error('Expected a legacy pair');
    layout.setSplitSizes(cut.id, [64, 36]);
    layout.setChatToolLayout(mode);

    const saved = layout.snapshot;
    const restored = makeLayout('owner');
    restored.restoreSnapshot(saved);
    expect(restored.chatToolLayout).toBe(mode);
    expect(restored.primaryChatTabId).toBe(owner);
    expect(restored.snapshot).toEqual(saved);
  });

  it('infers the legacy mode from the displayed panes, not from window width', () => {
    const layout = makeLayout('owner');
    const owner = layout.open('chat', { id: 'owner' }, newTab)!;
    const tool = layout.open('tool', { id: 'one' }, newTab)!;
    const { chatToolLayout: _mode, ...toolInFront } = layout.snapshot;
    const restored = makeLayout('owner');
    restored.restoreSnapshot(toolInFront);
    expect(restored.chatToolLayout).toBe('full');

    layout.focusedPane.setActiveTab(owner);
    const { chatToolLayout: _hidden, ...chatInFront } = layout.snapshot;
    restored.restoreSnapshot(chatInFront);
    expect(restored.chatToolLayout).toBe('hidden');

    layout.splitPane(layout.activePaneId, 'right', tool);
    const { chatToolLayout: _split, ...legacyPair } = layout.snapshot;
    restored.setSinglePaneHost(true);
    restored.restoreSnapshot(legacyPair);
    expect(restored.chatToolLayout).toBe('split');
    expect(restored.pair).toEqual({ pinned: owner, side: tool });
  });

  it('does not persist a populated mode for a tool that cannot survive a restart', () => {
    const layout = makeLayout('owner');
    const owner = layout.open('chat', { id: 'owner' }, newTab)!;
    layout.open('preview', { id: 'temporary' }, newTab);
    layout.setChatToolLayout('full');

    const saved = layout.snapshot;
    expect(saved.chatToolLayout).toBeUndefined();
    expect(saved.groups[0].tabManager.activeTabId).toBe(owner);
    const restored = makeLayout('owner');
    restored.restoreSnapshot(saved);
    expect(restored.chatToolLayout).toBe('empty');
  });

  it('preserves two-tool pairing and does not attach state to a tool-only host', () => {
    const layout = makeLayout('owner');
    layout.open('chat', { id: 'owner' }, newTab);
    const first = layout.open('tool', { id: 'one' }, newTab)!;
    const second = layout.open('tool', { id: 'two' }, newTab)!;
    layout.pairWith(first, second, { edge: 'right' });
    const pair = layout.pair;
    const tree = layout.layout;
    layout.setChatToolLayout('hidden');
    expect(layout.pair).toEqual(pair);
    expect(layout.layout).toBe(tree);

    const plain = makeLayout();
    plain.restoreSnapshot(layout.snapshot);
    expect(plain.chatToolLayout).toBeUndefined();
    expect(plain.snapshot.chatToolLayout).toBeUndefined();
    expect(plain.pair).toEqual(pair);
  });
});

describe('mounted chat workspace', () => {
  it('keeps tool order and resources in one pane while showing, hiding and filling only that pane', () => {
    const layout = makeLayout('owner');
    const owner = layout.open('chat', { id: 'owner' }, newTab)!;
    const detachWorkspace = layout.attachChatWorkspace();
    try {
      expect(layout.chatWorkspaceMode).toBe('empty');
      const first = layout.open('tool', { id: 'one' }, newTab)!;
      const panes = layout.chatWorkspacePanes!;
      const tools = panes.tools!.pane;
      const firstResource = tools._resources.get(first);
      expect(panes.chat.pane.tabOrder).toEqual([owner]);

      layout.setChatToolLayout('hidden');
      const second = layout.open('tool', { id: 'two' }, newTab)!;
      expect(layout.chatWorkspaceMode).toBe('hidden');
      expect(layout.activePaneId).toBe(panes.chat.paneId);
      expect(layout.isPaneShown(panes.tools!.paneId)).toBe(false);

      layout.setChatToolLayout('split');
      const before = layout.layout;
      layout.setChatToolLayout('full');
      tools.setActiveTab(first);
      expect(layout.chatWorkspaceMode).toBe('full');
      expect(layout.chatWorkspaceSinglePaneId).toBe(panes.tools!.paneId);
      expect(tools.tabOrder).toEqual([first, second]);
      expect(tools._resources.get(first)).toBe(firstResource);
      expect(layout.layout).toBe(before);
      expect(layout.isPaneShown(panes.chat.paneId)).toBe(false);

      tools.closeTab(first);
      expect(layout.chatWorkspaceMode).toBe('full');
      expect(tools.resolvedActiveTabId).toBe(second);
      tools.closeTab(second);
      expect(layout.chatWorkspaceMode).toBe('empty');
      expect(layout.stripTabIds).toEqual([owner]);
    } finally {
      detachWorkspace();
    }
  });

  it('closes tool tabs as a group without including the conversation in the tool strip', async () => {
    const layout = makeLayout('owner');
    const owner = layout.open('chat', { id: 'owner' }, newTab)!;
    const detachWorkspace = layout.attachChatWorkspace();
    try {
      layout.open('tool', { id: 'one' }, newTab);
      layout.open('tool', { id: 'two' }, newTab);
      const tools = layout.chatWorkspacePanes!.tools!.pane;
      tools.closeAll();
      await vi.waitFor(() => expect(layout.chatWorkspaceMode).toBe('empty'));
      expect(layout.stripTabIds).toEqual([owner]);
    } finally {
      detachWorkspace();
    }
  });

  it('reopens the whole group on either side and keeps order, resources and remembered width', () => {
    const layout = makeLayout('owner');
    const owner = layout.open('chat', { id: 'owner' }, newTab)!;
    const detach = layout.attachChatWorkspace();
    try {
      layout.setDimensions(1000, 600);
      const first = layout.open('tool', { id: 'one' }, newTab)!;
      const second = layout.open('tool', { id: 'two' }, newTab)!;
      const panes = layout.chatWorkspacePanes!;
      const tools = panes.tools!.pane;
      const firstResource = tools._resources.get(first);
      layout.setPaneSizes([38, 62]);
      layout.setChatToolLayout('full');

      layout.handleDragEnd(first, chatToolDropId('left', panes.chat.paneId));
      expect(layout.chatWorkspaceMode).toBe('split');
      expect(layout.chatToolSide).toBe('left');
      expect(layout.paneSizes).toEqual([62, 38]);
      expect(tools.tabOrder).toEqual([first, second]);
      expect(tools.resolvedActiveTabId).toBe(first);
      expect(tools._resources.get(first)).toBe(firstResource);

      layout.collapseChatToolSide('left');
      expect(layout.chatWorkspaceMode).toBe('hidden');
      layout.toggleChatToolSplit();
      expect(layout.paneSizes).toEqual([62, 38]);
      layout.collapseChatToolSide('right');
      expect(layout.chatWorkspaceMode).toBe('full');

      layout.handleDragEnd(second, chatToolDropId('right', panes.chat.paneId));
      expect(layout.chatToolSide).toBe('right');
      expect(layout.paneSizes).toEqual([38, 62]);
      expect(tools.resolvedActiveTabId).toBe(second);
      expect(panes.chat.pane.tabOrder).toEqual([owner]);
      expect(layout.pairDeclined).toBe(false);
    } finally {
      detach();
    }
  });

  it('bounds the size while previewing each collapsing edge only after the pointer passes the threshold', () => {
    const width = 1001;
    const at = (offset: number) => chatDividerAt(offset, width, 320, 360);
    expect(at(500)).toEqual({ sizes: [50, 50], preview: undefined, collapse: undefined });
    expect(at(180)).toEqual({ sizes: [32, 68], preview: 'left', collapse: undefined });
    expect(at(115)).toEqual({ sizes: [32, 68], preview: 'left', collapse: 'left' });
    expect(at(800)).toEqual({ sizes: [64, 36], preview: undefined, collapse: undefined });
    expect(at(985)).toEqual({ sizes: [64, 36], preview: 'right', collapse: 'right' });
  });

  it('retains the existing two-tool pairing when both tool pages are explicitly paired', () => {
    const layout = makeLayout('owner');
    const owner = layout.open('chat', { id: 'owner' }, newTab)!;
    const detachWorkspace = layout.attachChatWorkspace();
    try {
      const first = layout.open('tool', { id: 'one' }, newTab)!;
      const second = layout.open('tool', { id: 'two' }, newTab)!;
      layout.chatWorkspacePanes!.tools!.pane.splitTab(second);
      expect(layout.chatWorkspaceMode).toBeUndefined();
      expect(layout.pair).not.toBeNull();
      expect(new Set([layout.pair!.pinned, layout.pair!.side])).toEqual(new Set([first, second]));

      layout.groups.find(({ pane }) => pane.entries.has(owner))!.pane.setActiveTab(owner);
      expect(layout.chatWorkspaceMode).toBe('split');
      expect(layout.chatWorkspacePanes?.chat.pane.tabOrder).toEqual([owner]);
      expect(new Set(layout.chatWorkspacePanes?.tools?.pane.tabOrder)).toEqual(new Set([first, second]));
    } finally {
      detachWorkspace();
    }
  });
});
