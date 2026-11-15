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
  const registry = createTabRegistry([provider('conversation'), provider('folder'), provider('file'), provider('info', 360)]);
  const make = () => {
    const layout = new PaneLayoutStore(registry, { viewId: 'side-width' }, undefined, { placementMemory: { read: () => undefined, write() {} } });
    layout.setPaneSizer(() => ({ width: EXTENT / layout.groups.length, height: 800 }));
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
