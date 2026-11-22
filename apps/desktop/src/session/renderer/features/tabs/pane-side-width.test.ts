import { readFileSync } from 'node:fs';
import { runInAction } from 'mobx';
import { afterEach, describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { chatToolDropId } from './chat-tool-geometry';
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

  it('a page on the side turned into another in place comes at the new page\'s width, dragged or not', () => {
    const { layout, open, sideWidth, drag } = setup();
    const folder = open('folder');
    drag(800);
    layout.open('info', { path: 'info' }, { from: folder, intent: 'navigate' });
    expect(sideWidth()).toBe(360);
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
    const w = {
      layout,
      detach: layout.attachChatWorkspace(),
      open: (kind: string, path = kind) => w.layout.open(kind, { path }, { from: null, intent: 'newTab' })!,
      close: (tabId: string) => w.layout.groups.find(({ pane }) => pane.entries.has(tabId))!.pane.closeTab(tabId),
      /** The tool pane's width in px, as drawn. */
      sideWidth: () => {
        const cut = w.layout.layout;
        if (cut.type !== 'split') return null;
        const at = cut.children.findIndex((child) => child.type === 'pane' && child.paneId === w.layout.chatWorkspacePanes?.tools?.paneId);
        return Math.round((cut.sizes[at] * EXTENT) / 100);
      },
      drag: (px: number) => {
        const cut = w.layout.layout;
        if (cut.type !== 'split') throw new Error('not split');
        const tools = w.layout.chatWorkspacePanes!.tools!.paneId;
        const share = (px / EXTENT) * 100;
        w.layout.setSplitSizes(cut.id, cut.children.map((child) => (child.type === 'pane' && child.paneId === tools ? share : 100 - share)));
      },
    };
    layout.setDimensions(EXTENT, 800);
    return w;
  }

  /** Each way a page comes to the side, from a tool pane left at the 「+」 page's dragged 900: the members come at 360. */
  const ways: Record<string, (w: ReturnType<typeof workspace>) => void> = {
    'opened after the 「+」 page closed (owner 11-19)': ({ open, close, drag }) => {
      const start = open('start'); drag(900); close(start);
      open('info');
    },
    'the 「+」 page turned into it in place (owner 11-22)': ({ layout, open, drag }) => {
      const start = open('start'); drag(900);
      layout.open('info', { path: 'info' }, { from: start, intent: 'navigate', inPlace: true });
    },
    'the 「+」 page, never dragged, turned into it in place': ({ layout, open }) => {
      const start = open('start');
      layout.open('info', { path: 'info' }, { from: start, intent: 'navigate', inPlace: true });
    },
    'opened in front of the 「+」 page': ({ open, drag }) => {
      open('start'); drag(900);
      open('info');
    },
    'its tab brought to the front': ({ layout, open, drag }) => {
      const members = open('info'); const start = open('start'); drag(900);
      const tools = layout.chatWorkspacePanes!.tools!.pane;
      tools.setActiveTab(start); tools.setActiveTab(members);
    },
    'back in front when the 「+」 page in front of it closes': ({ open, close, drag }) => {
      open('info'); const start = open('start'); drag(900);
      close(start);
    },
    'its tool group dropped on the other edge': ({ layout, open, drag }) => {
      const members = open('info'); open('start'); drag(900);
      layout.setChatToolLayout('full');
      layout.handleDragEnd(members, chatToolDropId('left', layout.chatWorkspacePanes!.chat.paneId));
    },
    'a restart': (w) => {
      const start = w.open('start'); w.drag(900); w.open('info');
      const restarted = workspace();
      restarted.layout.restoreSnapshot(JSON.parse(JSON.stringify(w.layout.snapshot)));
      w.detach();
      Object.assign(w, { layout: restarted.layout, detach: restarted.detach });
      void start;
    },
    'the divider dragged, then double-clicked': ({ layout, open, drag }) => {
      open('start'); drag(900); open('info'); drag(500);
      const cut = layout.layout;
      if (cut.type !== 'split') throw new Error('not split');
      layout.equalizeSplit(cut.id);
    },
  };

  it.each(Object.keys(ways))('the members come at their own width: %s', (way) => {
    const w = workspace();
    try {
      ways[way](w);
      expect(w.sideWidth()).toBe(360);
    } finally { w.detach(); }
  });

  it('a dragged width stays the page\'s own: it comes back with the page, not with the pane', () => {
    const { layout, detach, open, sideWidth, drag } = workspace();
    try {
      const start = open('start');
      drag(900);
      const members = open('info');
      const tools = layout.chatWorkspacePanes!.tools!.pane;
      tools.setActiveTab(start);
      expect(sideWidth()).toBe(900);
      tools.setActiveTab(members);
      expect(sideWidth()).toBe(360);
    } finally { detach(); }
  });
});

// @@@seat-side guard: a page's width on the side is chosen in one place. A new path that writes the pair's shares itself
// (as #3065's open and drop did) fails here; route it through `_seatSide` instead.
describe('the pair\'s shares are written in one place', () => {
  it('only _seatSide, a cut that is not the pair\'s, and the restored saved cut write shares', () => {
    const source = readFileSync(new URL('./pane-layout-store.ts', import.meta.url), 'utf8').split('\n');
    const writes = source.flatMap((line, at) => {
      if (!/\bsizes:\s|\bsetSplitSizes\(this\.layout|\bequalizeSplit\(this\.layout|\.sizes\s*=[^=]/.test(line)) return [];
      const owner = source.slice(0, at + 1).reverse().map((l) => /^ {2}(?:private |static )?(?:get |set )?(\w+)(?:<[^>]*>)?\(/.exec(l)?.[1]).find(Boolean);
      return [owner];
    });
    expect(new Set(writes)).toEqual(new Set(['setSplitSizes', 'equalizeSplit', '_seatSide', '_restorePair']));
  });
});
