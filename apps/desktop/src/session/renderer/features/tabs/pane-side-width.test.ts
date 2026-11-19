import { runInAction } from 'mobx';
import { afterEach, describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';

// The pair's cut belongs to the page on the side (@@@side-width): each page brings its own width there. Owner 11-10:
// a chat's folder, then its members, then the members closed — the folder came back at the members' width.

const layouts: PaneLayoutStore[] = [];
afterEach(() => layouts.splice(0).forEach((layout) => layout.dispose()));

const EXTENT = 1200;
function setup() {
  // `info` declares the side-page width (a chat's members); `folder` and `file` declare nothing (peers, half each).
  const provider = (kind: string, sideWidth?: number) => createTabProvider({
    kind,
    conversation: kind === 'conversation',
    resourceKey: (state: { path: string }) => state.path,
    initialize: () => ({ dispose() {} }),
    dispose() {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
    ...(sideWidth ? { sideWidth: () => sideWidth } : {}),
  });
  const registry = createTabRegistry([provider('conversation'), provider('folder'), provider('file'), provider('info', 360), provider('wide', 480)]);
  const make = () => {
    const layout = new PaneLayoutStore(registry, { viewId: 'side-width' }, undefined, { placementMemory: { read: () => undefined, write() {} } });
    layout.setDimensions(EXTENT, 800);
    layouts.push(layout);
    return layout;
  };
  const layout = make();
  const conversation = layout.open('conversation', { path: 'conversation' }, { from: null, intent: 'newTab' })!;
  const open = (kind: string, path = kind) => layout.open(kind, { path }, { from: conversation, intent: 'navigate' })!;
  const close = (tabId: string) => layout.groups.find(({ pane }) => pane.entries.has(tabId))!.pane.closeTab(tabId);
  /** The side page's width in px, as drawn. */
  const sideWidth = (of: PaneLayoutStore = layout) => {
    const cut = of.layout;
    if (cut.type !== 'split') return null;
    const at = cut.children.findIndex((child) => child.type === 'pane' && child.paneId === of.sidePaneId);
    return Math.round((cut.sizes[at] * EXTENT) / 100);
  };
  const drag = (px: number) => {
    const cut = layout.layout;
    if (cut.type !== 'split') throw new Error('not paired');
    const share = (px / EXTENT) * 100;
    layout.setSplitSizes(cut.id, cut.children.map((child) => (child.type === 'pane' && child.paneId === layout.sidePaneId ? share : 100 - share)));
  };
  return { layout, make, open, close, sideWidth, drag };
}

describe('every page on the side comes at its own width', () => {
  it('folder, members, members closed: the folder is back at its own width (owner 11-10)', () => {
    const { open, close, sideWidth } = setup();
    open('folder');
    expect(sideWidth()).toBe(600);
    const members = open('info');
    expect(sideWidth()).toBe(360);
    close(members);
    expect(sideWidth()).toBe(600);
  });

  it('members, folder, folder closed: the members are back at the side-page width', () => {
    const { open, close, sideWidth } = setup();
    open('info');
    const folder = open('folder');
    expect(sideWidth()).toBe(600);
    close(folder);
    expect(sideWidth()).toBe(360);
  });

  it('closing the one pushed out leaves the one on screen at its own width', () => {
    const one = setup();
    const folder = one.open('folder');
    one.open('info');
    one.close(folder);
    expect(one.sideWidth()).toBe(360);
    const two = setup();
    const members = two.open('info');
    two.open('folder');
    two.close(members);
    expect(two.sideWidth()).toBe(600);
  });

  it('a dragged width is that page\'s: it survives another page on the side and comes back with it', () => {
    const { layout, open, close, sideWidth, drag } = setup();
    const folder = open('folder');
    drag(720);
    const members = open('info');
    expect(sideWidth()).toBe(360);
    close(members);
    expect(sideWidth()).toBe(720);
    // Its tab clicked while another page is on the side: the same.
    open('info');
    layout.groups.find(({ pane }) => pane.entries.has(folder))!.pane.setActiveTab(folder);
    expect(sideWidth()).toBe(720);
  });

  it('a dragged width is not another page\'s: the next file is a peer again', () => {
    const { open, sideWidth, drag } = setup();
    open('file', 'A.md');
    drag(840);
    open('file', 'B.md');
    expect(sideWidth()).toBe(600);
    open('file', 'A.md');
    expect(sideWidth()).toBe(840);
  });

  it('double-clicking the divider forgets the dragged width', () => {
    const { layout, open, sideWidth, drag } = setup();
    open('info');
    drag(500);
    const cut = layout.layout;
    if (cut.type !== 'split') throw new Error('not paired');
    layout.equalizeSplit(cut.id);
    expect(sideWidth()).toBe(360);
  });

  it('a restart keeps each page\'s own width, the one on screen and the one pushed out', () => {
    const { layout, make, open, sideWidth, drag } = setup();
    open('folder');
    drag(720);
    open('info');
    drag(420);
    const restarted = make();
    restarted.restoreSnapshot(JSON.parse(JSON.stringify(layout.snapshot)));
    expect(sideWidth(restarted)).toBe(420);
    const members = restarted.pair!.side;
    restarted.groups.find(({ pane }) => pane.entries.has(members))!.pane.closeTab(members);
    expect(sideWidth(restarted)).toBe(720);
  });

  it('a restart brings a declared width back to the pixel, not to a whole percent', () => {
    const { layout, make, open, sideWidth } = setup();
    open('info');
    const restarted = make();
    restarted.restoreSnapshot(JSON.parse(JSON.stringify(layout.snapshot)));
    expect(sideWidth(restarted)).toBe(360);
  });

  it('a closed page takes its width with it', () => {
    const { layout, open, close, drag } = setup();
    const a = open('file', 'A.md');
    drag(840);
    close(a);
    expect(layout.snapshot.sideShares).toBeUndefined();
  });
});

// A page of the pair in full screen measures the workspace, not its cell: the pair's shares come from the tree as drawn
// (PaneTreeView), so lighting the pair up again (its tab clicked, `pairWith`) keeps each declared width.
describe('a page in full screen is no measure of the pair', () => {
  it('re-pairing while one page covers the workspace keeps the declared widths (480, 360)', () => {
    const { layout, open, sideWidth } = setup();
    const wide = open('wide');
    expect(sideWidth()).toBe(480);
    const members = open('info');
    expect(sideWidth()).toBe(360);
    // The conversation's page in full screen: it (and its pane's own sink) measures the whole workspace.
    layout.mainGroup.pane.setDimensions(EXTENT + 240, 900);
    layout.groups.find(({ pane }) => pane.entries.has(wide))!.pane.setActiveTab(wide);
    expect(sideWidth()).toBe(480);
    layout.setActiveGroup(layout.mainGroup.paneId);
    layout.groups.find(({ pane }) => pane.entries.has(members))!.pane.setActiveTab(members);
    expect(sideWidth()).toBe(360);
  });
});

// The pair already on screen: clicking a tab already in front (or the full-screen button, which brings its tab to the
// front first) is no page arriving — the shares stay as they are, whatever left them there.
describe('the pair on screen keeps its shares', () => {
  /** The cut set directly, as a page navigating in place leaves it — not a width recorded for any page. */
  const leave = (layout: PaneLayoutStore, sidePx: number) => {
    const cut = layout.layout;
    if (cut.type !== 'split') throw new Error('not paired');
    const share = (sidePx / EXTENT) * 100;
    runInAction(() => { layout.layout = { ...cut, sizes: cut.children.map((child) => (child.type === 'pane' && child.paneId === layout.sidePaneId ? share : 100 - share)) }; });
  };
  const front = (layout: PaneLayoutStore, tabId: string) => layout.groups.find(({ pane }) => pane.entries.has(tabId))!.pane.setActiveTab(tabId);

  it('the side tab, or the pinned one, clicked while in front: the shares stay', () => {
    const { layout, open, sideWidth } = setup();
    const members = open('info');
    expect(sideWidth()).toBe(360);
    leave(layout, 600);
    front(layout, members);
    expect(sideWidth(), 'the side page in front clicked again').toBe(600);
    front(layout, layout.pair!.pinned);
    expect(sideWidth(), 'the pinned page in front clicked again').toBe(600);
  });

  it('another tab brought to the side from the strip comes at its own width', () => {
    const { layout, open, sideWidth } = setup();
    const members = open('info');
    open('wide');
    expect(sideWidth()).toBe(480);
    leave(layout, 600);
    front(layout, members);
    expect(sideWidth()).toBe(360);
  });
});

// The chat page's tools (a chat with its tool pages beside it): the tool pane is no owner of a width either. Owner 11-19:
// 「+」, closed, then the members — the members came at the 「+」 page's width.
describe('a chat\'s tool pages come at their own width', () => {
  const provider = (kind: string, sideWidth?: number) => createTabProvider({
    kind,
    conversation: kind === 'chat',
    resourceKey: (state: { path: string }) => state.path,
    initialize: () => ({ dispose() {} }),
    dispose() {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
    ...(sideWidth ? { sideWidth: () => sideWidth } : {}),
  });
  const registry = createTabRegistry([provider('chat'), provider('start'), provider('info', 360)]);
  function workspace() {
    const layout = new PaneLayoutStore(registry, { viewId: 'chat-tools' }, undefined, {
      isPrimaryChatTab: (entry) => entry.kind === 'chat',
      placementMemory: { read: () => undefined, write() {} },
    });
    layouts.push(layout);
    layout.open('chat', { path: 'chat' }, { from: null, intent: 'newTab' });
    const detach = layout.attachChatWorkspace();
    layout.setDimensions(EXTENT, 800);
    const open = (kind: string, path = kind) => layout.open(kind, { path }, { from: null, intent: 'newTab' })!;
    const close = (tabId: string) => layout.groups.find(({ pane }) => pane.entries.has(tabId))!.pane.closeTab(tabId);
    const sideWidth = () => {
      const cut = layout.layout;
      if (cut.type !== 'split') return null;
      const at = cut.children.findIndex((child) => child.type === 'pane' && child.paneId === layout.chatWorkspacePanes?.tools?.paneId);
      return Math.round((cut.sizes[at] * EXTENT) / 100);
    };
    const drag = (px: number) => {
      const cut = layout.layout;
      if (cut.type !== 'split') throw new Error('not split');
      const tools = layout.chatWorkspacePanes!.tools!.paneId;
      const share = (px / EXTENT) * 100;
      layout.setSplitSizes(cut.id, cut.children.map((child) => (child.type === 'pane' && child.paneId === tools ? share : 100 - share)));
    };
    return { layout, detach, open, close, sideWidth, drag };
  }

  it('「+」 dragged wide and closed, then the members: the members come at their own width (owner 11-19)', () => {
    const { detach, open, close, sideWidth, drag } = workspace();
    try {
      const start = open('start');
      expect(sideWidth()).toBe(600);
      drag(900);
      close(start);
      open('info');
      expect(sideWidth()).toBe(360);
    } finally { detach(); }
  });

  it('switching between open tools: each comes at its own width, a dragged one at its dragged width', () => {
    const { layout, detach, open, sideWidth, drag } = workspace();
    try {
      const start = open('start');
      drag(900);
      const members = open('info');
      expect(sideWidth()).toBe(360);
      const tools = layout.chatWorkspacePanes!.tools!.pane;
      tools.setActiveTab(start);
      expect(sideWidth()).toBe(900);
      tools.setActiveTab(members);
      expect(sideWidth()).toBe(360);
    } finally { detach(); }
  });
});
