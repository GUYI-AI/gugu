import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore, paneEdgeDropId } from './pane-layout-store';

const layouts: PaneLayoutStore[] = [];
afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

function setup(place: 'chat' | 'session') {
  const initialize = vi.fn(() => ({ dispose() {} }));
  const dispose = vi.fn();
  const provider = (kind: string) => createTabProvider({ kind, conversation: kind !== 'file', minWidth: kind !== 'file' ? 360 : undefined, resourceKey: (state: { id: string }) => state.id, initialize, dispose, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null });
  const layout = new PaneLayoutStore(createTabRegistry(['conversation', 'topic', 'file'].map(provider)), {
    viewId: `${place}:placement`, place: place === 'chat' ? { kind: 'chat', chatId: 'placement' } : { kind: 'session', sessionId: 'placement', projectId: 'project' },
  }, undefined, { placementMemory: { read: () => undefined, write() {} } });
  layouts.push(layout);
  layout.setDimensions(1200, 800);
  const conversation = layout.open('conversation', { id: 'conversation' }, { from: null, intent: 'newTab' })!;
  const main = layout.mainGroup;
  const topic = layout.open('topic', { id: 'topic' }, { from: conversation, intent: 'navigate' })!;
  const side = layout.sideGroup!;
  const file = (id: string, intent: 'navigate' | 'newTab' = 'navigate') => layout.open('file', { id }, { from: conversation, intent })!;
  return { layout, main, side, conversation, topic, file, initialize, dispose };
}

describe.each(['chat', 'session'] as const)('%s pane placement', (place) => {
  it('keeps the current topic in its pane when the other conversation opens a file, and restores that conversation on close', () => {
    const { layout, main, side, conversation, topic, file } = setup(place);
    layout.setActiveGroup(side.paneId);
    const resource = side.pane._resources.get(topic);
    const opened = file('preview.html');
    expect(layout.activePaneId).toBe(side.paneId);
    expect(side.pane.resolvedActiveTabId).toBe(topic);
    expect(side.pane._resources.get(topic)).toBe(resource);
    expect(main.pane.resolvedActiveTabId).toBe(opened);
    expect(layout.pair).toEqual({ pinned: opened, side: topic });
    main.pane.closeTab(opened);
    expect(layout.pair).toEqual({ pinned: conversation, side: topic });
    expect(layout.activePaneId).toBe(side.paneId);
  });

  it('keeps two visible files in place when one is opened again from a conversation', () => {
    const { layout, side, main, file } = setup(place);
    const a = file('a.html');
    layout.setActiveGroup(side.paneId);
    const b = file('b.html');
    const before = JSON.stringify(layout.snapshot);
    expect(file('b.html')).toBe(b);
    expect(main.pane.resolvedActiveTabId).toBe(b);
    expect(side.pane.resolvedActiveTabId).toBe(a);
    expect(JSON.stringify(layout.snapshot)).toBe(before);
  });

  it.each(['main', 'side'] as const)('replaces a %s center with a hidden tab and restores the physical pair after a snapshot', (which) => {
    const { layout, main, side } = setup(place);
    const moving = layout.open('file', { id: 'hidden.html' }, { from: null, intent: 'newTab', activate: false })!;
    const target = which === 'main' ? main : side;
    const other = which === 'main' ? side : main;
    const keep = other.pane.resolvedActiveTabId;
    layout.handleDragEnd(moving, `pane-content-${target.paneId}`);
    expect(target.pane.resolvedActiveTabId).toBe(moving);
    expect(other.pane.resolvedActiveTabId).toBe(keep);
    const before = layout.pair;
    layout.restoreSnapshot(JSON.parse(JSON.stringify(layout.snapshot)));
    expect(layout.pair).toEqual(before);
    expect(layout.isPairVisible).toBe(true);
  });

  it.each(['main', 'side'] as const)('swaps a visible page dropped on the %s center without recreating resources', (which) => {
    const { layout, main, side, conversation, topic, initialize, dispose } = setup(place);
    const target = which === 'main' ? main : side;
    const from = which === 'main' ? side : main;
    const moving = from.pane.resolvedActiveTabId!;
    const replaced = target.pane.resolvedActiveTabId!;
    const resource = from.pane._resources.get(moving);
    initialize.mockClear(); dispose.mockClear();
    layout.handleDragEnd(moving, `pane-content-${target.paneId}`);
    expect(target.pane.resolvedActiveTabId).toBe(moving);
    expect(from.pane.resolvedActiveTabId).toBe(replaced);
    expect(target.pane._resources.get(moving)).toBe(resource);
    expect(new Set([layout.pair!.pinned, layout.pair!.side])).toEqual(new Set([conversation, topic]));
    expect(initialize).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  });

  it('separates the pair when its side tab is dropped at the end of the strip', () => {
    const { layout, main, topic } = setup(place);
    layout.handleDragEnd(topic, `pane-drop-${main.paneId}`);
    expect(layout.pair).toBeNull();
    expect(layout.groups).toHaveLength(1);
    expect(main.pane.resolvedActiveTabId).toBe(topic);
    expect(layout.stripTabIds.at(-1)).toBe(topic);
  });

  it('selects a hidden strip tab beside the current side pane', () => {
    const { layout, main, side, topic } = setup(place);
    const hidden = layout.open('file', { id: 'hidden.html' }, { from: null, intent: 'newTab', activate: false })!;
    layout.setActiveGroup(side.paneId);
    main.pane.setActiveTab(hidden);
    expect(side.pane.resolvedActiveTabId).toBe(topic);
    expect(main.pane.resolvedActiveTabId).toBe(hidden);
    expect(layout.activePaneId).toBe(main.paneId);
  });

  it.each(['left', 'right'] as const)('places a file on the %s edge of the side page, keeping that page instead of the old main', (edge) => {
    const { layout, main, side, topic } = setup(place);
    const moving = layout.open('file', { id: 'another.html' }, { from: null, intent: 'newTab', activate: false })!;
    layout.handleDragEnd(moving, paneEdgeDropId(edge, side.paneId));
    expect(side.pane.resolvedActiveTabId).toBe(topic);
    expect(main.pane.resolvedActiveTabId).toBe(moving);
    expect(layout.groups).toHaveLength(2);
    expect(layout.layout).toMatchObject({ type: 'split', children: edge === 'left' ? [{ paneId: main.paneId }, { paneId: side.paneId }] : [{ paneId: side.paneId }, { paneId: main.paneId }] });
  });

  it('reveals the opened target in a narrow window without discarding either pane', () => {
    const { layout, main, side, topic, file } = setup(place);
    layout.setActiveGroup(side.paneId);
    layout.setDimensions(300, 800);
    const opened = file('preview.html');
    expect(layout.activePaneId).toBe(main.paneId);
    expect(main.pane.resolvedActiveTabId).toBe(opened);
    expect(side.pane.resolvedActiveTabId).toBe(topic);
    expect(layout.groups).toHaveLength(2);
  });

  it('reveals a newly created pane when its declared minimum widths make the first split narrow', () => {
    const { layout, conversation, topic } = setup(place);
    layout.unpair({ fill: 'pinned' });
    layout.setDimensions(600, 800);
    layout.open('topic', { id: 'topic' }, { from: conversation, intent: 'navigate' });
    expect(layout.focusedPane.resolvedActiveTabId).toBe(topic);
    expect(layout.groups).toHaveLength(2);
  });

  it('reveals the opened target for a single-pane phone host even before it has measurements', () => {
    const { layout, main, side, topic, file } = setup(place);
    layout.dimensions = null;
    layout.setSinglePaneHost(true);
    layout.setActiveGroup(side.paneId);
    const opened = file('phone.html');
    expect(layout.focusedPane.resolvedActiveTabId).toBe(opened);
    expect(main.pane.resolvedActiveTabId).toBe(opened);
    expect(side.pane.resolvedActiveTabId).toBe(topic);
    layout.setDimensions(1200, 800);
    expect(layout.narrow).toBe(true);
  });
});
