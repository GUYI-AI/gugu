import { afterEach, describe, expect, it } from 'vitest';
import type { TabGroupsSnapshot } from '@shared/view-state';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';
import { paneOrder } from './pane-layout-tree';

// A layout's tree names each pane exactly once, and every pane in it has tabs: a cut with the same pane on both sides
// draws an empty cell beside it.

const layouts: PaneLayoutStore[] = [];
afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

function make() {
  const provider = (kind: string) => createTabProvider({
    kind,
    conversation: kind === 'acp-chat',
    resourceKey: (state: { path?: string }) => state?.path ?? kind,
    initialize: () => ({ dispose() {} }),
    dispose() {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const registry = createTabRegistry(['acp-chat', 'browser', 'folder', 'file'].map(provider));
  const layout = new PaneLayoutStore(registry, { viewId: 'dup-pane' }, undefined, {
    isPrimaryChatTab: (entry) => entry.kind === 'acp-chat',
    placementMemory: { read: () => undefined, write() {} },
  });
  layout.setDimensions(1200, 800);
  layouts.push(layout);
  return layout;
}

function expectLegal(layout: PaneLayoutStore) {
  const order = paneOrder(layout.layout);
  expect(new Set(order).size).toBe(order.length);
  expect([...order].sort()).toEqual(layout.groups.map((g) => g.paneId).sort());
  for (const { pane } of layout.groups) expect(pane.tabOrder.length).toBeGreaterThan(0);
  if (layout.sidePaneId !== null) expect(layout.mainGroup.paneId).not.toBe(layout.sidePaneId);
}

describe('a pane is in the tree once', () => {
  it('the main pane closed beside its side: the next pair cuts the pane left beside a new one, not beside itself', () => {
    const layout = make();
    const chat = layout.open('acp-chat', {}, { from: null, intent: 'newTab' })!;
    const folder = layout.open('folder', { path: 'folder' }, { from: chat, intent: 'navigate' })!;
    expect(layout.sidePaneId).not.toBeNull();
    const main = layout.mainGroup.paneId;
    layout.closePane(main);
    expect(layout.groups).toHaveLength(1);
    const file = layout.open('file', { path: 'A.md' }, { from: null, intent: 'newTab' })!;
    layout.pairWith(folder, file);
    expectLegal(layout);
  });

  it('a saved tree naming one pane twice, its pair with the roles swapped, comes back legal (held-out 11-26)', () => {
    const browserGroup = 'd2ad45d1-7794-4577-821b-37f436a8acb6';
    const chatGroup = 'b0ad8491-05c0-46f0-88f8-4c3304be6201';
    const browserTab = '3f983350-500a-492b-8071-4da61b76b07d';
    const chatTab = 'c1da428f-91ef-4cd4-91cb-5b54e3ede6d1';
    const saved = {
      chatToolLayout: 'split',
      groups: [
        { groupId: browserGroup, tabManager: { tabs: [{ kind: 'browser', tabId: browserTab, browserId: 'e130f0ae', workspaceStart: true }], activeTabId: browserTab } },
        { groupId: chatGroup, tabManager: { tabs: [{ kind: 'acp-chat', tabId: chatTab, sessionId: 'f2369635' }], activeTabId: chatTab } },
      ],
      activeGroupId: browserGroup,
      paneSizes: [50, 50],
      layout: {
        split: 'horizontal',
        children: [
          { split: 'horizontal', children: [{ pane: browserGroup }, { pane: browserGroup }], sizes: [50, 50] },
          { pane: chatGroup },
        ],
        sizes: [50, 50],
      },
      sideGroupId: chatGroup,
      pair: { pinnedTabId: browserTab, sideTabId: chatTab },
    } as unknown as TabGroupsSnapshot;
    const layout = make();
    layout.restoreSnapshot(saved);
    expectLegal(layout);
    expect(layout.mainGroup.paneId).toBe(chatGroup);
    expect(layout.pair).toEqual({ pinned: chatTab, side: browserTab });
    // Saved again and read back: still legal.
    const again = make();
    again.restoreSnapshot(layout.snapshot);
    expectLegal(again);
  });

  it('a pane saved without tabs does not come back', () => {
    const layout = make();
    const chat = layout.open('acp-chat', {}, { from: null, intent: 'newTab' })!;
    const snapshot = layout.snapshot;
    const saved = {
      ...snapshot,
      groups: [...snapshot.groups, { groupId: 'empty', tabManager: { tabs: [], activeTabId: null } }],
      layout: { split: 'horizontal', children: [snapshot.layout, { pane: 'empty' }], sizes: [50, 50] },
    } as unknown as TabGroupsSnapshot;
    const restored = make();
    restored.restoreSnapshot(saved);
    expectLegal(restored);
    expect(restored.groups.flatMap(({ pane }) => pane.tabOrder)).toEqual([chat]);
  });
});
