import { afterEach, describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';

// `onActivate` means 「this page came on screen」. A page moved between panes while on screen (向右分, a pair collapsing,
// a window) did not come on screen: the move says so (@@@carried-on-screen).

const layouts: PaneLayoutStore[] = [];
afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

function setup() {
  const activated: string[] = [];
  const provider = (kind: string) => createTabProvider({
    kind,
    conversation: kind === 'conversation',
    resourceKey: (state: { path: string }) => state.path,
    initialize: (entry: { state: unknown }) => ({ dispose() {}, onActivate() { activated.push((entry.state as { path: string }).path); } }),
    dispose() {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
  const layout = new PaneLayoutStore(createTabRegistry(['conversation', 'file'].map(provider)), { viewId: 'activate' }, undefined, { placementMemory: { read: () => undefined, write() {} } });
  layouts.push(layout);
  layout.setViewActive(true);
  const conversation = layout.open('conversation', { path: 'C' }, { from: null, intent: 'newTab' })!;
  const open = (path: string) => layout.open('file', { path }, { from: conversation, intent: 'beside' })!;
  const step = (run: () => void) => { activated.length = 0; run(); return [...activated]; };
  return { layout, conversation, open, step };
}

describe('a page moved between panes while on screen is not activated again', () => {
  it('向右分: only the page that comes on screen is activated, not the one moved beside it', () => {
    const { layout, open, step } = setup();
    open('A');
    open('B');
    layout.unpair({ declined: true });
    expect(layout.mainGroup.pane.shownTabIds.length).toBe(1);
    // Only B on screen (it filled the block); 向右分 moves B to the side and brings C back on screen beside it.
    expect(step(() => layout.splitRight())).toEqual(['C']);
  });

  it('a pair collapsing (the pinned page closed): the side stays on screen, not activated again', () => {
    const { layout, conversation, open, step } = setup();
    open('A');
    expect(step(() => layout.groups.find(({ pane }) => pane.entries.has(conversation))!.pane.closeTab(conversation))).toEqual([]);
  });

  it('a page put in a window of its own was on screen: not activated again', () => {
    const { layout, open, step } = setup();
    const a = open('A');
    expect(step(() => layout.detachToWindow(a))).toEqual([]);
  });

  it('a page moved while hidden still comes on screen later: activated then', async () => {
    const { layout, conversation, open, step } = setup();
    const a = open('A');
    const b = open('B');
    void a;
    // A is behind B on the side; separating moves it into the main pane, hidden.
    layout.unpair({ declined: true, fill: 'pinned' });
    await Promise.resolve();
    expect(step(() => layout.mainGroup.pane.setActiveTab(a))).toEqual(['A']);
    void conversation; void b;
  });
});
