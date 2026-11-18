import { afterEach, describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
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
