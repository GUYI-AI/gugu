import { DndContext } from '@dnd-kit/core';
import { act, useEffect } from 'react';
import { afterAll, afterEach, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { PaneTreeView } from '@renderer/features/tabs/pane-tree-view';
import { TrackCut } from '@renderer/features/tabs/pane-track-cut';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneContext } from '@renderer/features/tabs/pane-context';
import { tabFullscreen, WORKSPACE_ANCHOR } from '@renderer/features/tabs/tab-fullscreen';
import { WINDOW_CONTROL_BAR_HEIGHT_PX } from '@/lib/window-chrome';
import '@renderer/index.css';
import '@/styles/tokens.css';

let harness: ReturnType<typeof createReactHarness>;
let layout: PaneLayoutStore;
const viewport = { width: window.innerWidth, height: window.innerHeight };
afterAll(() => page.viewport(viewport.width, viewport.height));
afterEach(() => { harness?.cleanup(); layout?.dispose(); });

async function mount(minWidth?: number) {
  await page.viewport(1100, 800);
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px';
  const provider = createTabProvider({ kind: 'page', minWidth, resourceKey: (state: { id: string }) => state.id, initialize: () => ({ dispose() {} }), dispose() {}, TabContent: () => null, TabBarItem: () => null, TabBarItemDragPreview: () => null });
  layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'tree-v3' });
  layout.open('page', { id: 'conversation' }, { from: null, intent: 'newTab' });
  const other = layout.open('page', { id: 'folder' }, { from: null, intent: 'newTab' })!;
  layout.focusedPane.setDimensions(harness.container.clientWidth, harness.container.clientHeight);
  expect(layout.splitPane(layout.activePaneId, 'right', other)).toBe(true);
  await act(() => harness.render(<PaneTreeView layout={layout} renderPane={(id, _first, _last, part) => (part === 'bar' ? null : <iframe title={id} style={{ width: '100%', height: '100%' }} />)} />));
  await until('the actual split has a measurable divider', () => harness.container.querySelector<HTMLElement>('[data-slot="resizable-handle"]')?.getBoundingClientRect().height ?? 0, (height) => height > 100);
}

it('shields embedded pages during a real divider drag and releases the shield on mouse-up', async () => {
  await mount();
  const separator = harness.container.querySelector<HTMLElement>('[data-slot="resizable-handle"]')!;
  const rect = separator.getBoundingClientRect();
  const before = JSON.stringify(layout.snapshot.layout);
  const x = rect.left + rect.width / 2;
  const y = rect.top + 80;
  expect(separator.contains(document.elementFromPoint(x, y)), JSON.stringify({ divider: rect.toJSON(), viewport: { width: innerWidth, height: innerHeight }, hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 250) })).toBe(true);
  const mouse = async (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', localX: number, pressed = false) => {
    let x = localX, topY = y;
    for (let current: Window = window; current.frameElement; current = current.parent) {
      const frame = current.frameElement as HTMLElement, box = frame.getBoundingClientRect();
      const scale = box.width / frame.offsetWidth;
      x = box.left + (frame.clientLeft + x) * scale;
      topY = box.top + (frame.clientTop + topY) * scale;
    }
    await cdp().send('Input.dispatchMouseEvent', { type, x, y: topY, button: type === 'mouseMoved' && !pressed ? 'none' : 'left', buttons: pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  };
  await mouse('mouseMoved', x);
  await mouse('mousePressed', x, true);
  try {
    await until('the divider enables the shared native-page shield', () => document.documentElement.hasAttribute('data-gugu-dragging'));
    expect(getComputedStyle(harness.container.querySelector('iframe')!).pointerEvents).toBe('none');
    await mouse('mouseMoved', x + 80, true);
  } finally {
    await mouse('mouseReleased', x + 80);
  }
  await until('the user resize is saved', () => JSON.stringify(layout.snapshot.layout), (value) => value !== before);
  expect(document.documentElement.hasAttribute('data-gugu-dragging')).toBe(false);
});

it('a cut given other shares moves its divider over frames, and lays its panes out only where it starts and lands', async () => {
  await mount();
  const root = layout.layout;
  if (root.type !== 'split') throw new Error('mount makes a split');
  const divider = harness.container.querySelector<HTMLElement>('[data-slot="resizable-handle"]')!;
  const place = harness.container.querySelector<HTMLElement>('[data-panel-slot]')!;
  const edges: number[] = [];
  const places = new Set<string>();
  await act(async () => layout.setSplitSizes(root.id, [30, 70]));
  const start = performance.now();
  while (performance.now() - start < 900) {
    await new Promise(requestAnimationFrame);
    edges.push(Math.round(divider.getBoundingClientRect().left));
    places.add(place.style.width);
  }
  expect(new Set(edges).size, JSON.stringify(edges)).toBeGreaterThan(5);
  // the place is the smaller width the whole way (the start's layout), then the landing's: one layout at each end
  expect(places.size, [...places].join(' ')).toBeLessThanOrEqual(2);
  // lands on 30% of the cut (less its one divider pixel)
  const cut = divider.parentElement!.getBoundingClientRect();
  expect(Math.abs(edges.at(-1)! - cut.left - 0.3 * (cut.width - 1))).toBeLessThan(1.5);
});

it('the side page comes in on the track: it slides in from the end, and the page beside it is laid out once', async () => {
  await page.viewport(1100, 800);
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px';
  const provider = createTabProvider({ kind: 'page', resourceKey: (state: { id: string }) => state.id, initialize: () => ({ dispose() {} }), dispose() {}, TabContent: () => null, TabBarItem: () => null, TabBarItemDragPreview: () => null });
  layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'tree-v3-enter' });
  layout.open('page', { id: 'conversation' }, { from: null, intent: 'newTab' });
  const file = layout.open('page', { id: 'file' }, { from: null, intent: 'newTab' })!;
  layout.focusedPane.setDimensions(harness.container.clientWidth, harness.container.clientHeight);
  const kept = layout.activePaneId;
  await act(() => harness.render(<PaneTreeView layout={layout} renderPane={(id, _first, _last, part) => (part === 'bar' ? null : <iframe title={id} style={{ width: '100%', height: '100%' }} />)} />));
  await act(() => { expect(layout.splitPane(kept, 'right', file)).toBe(true); });
  const other = layout.groups.find(({ paneId }) => paneId !== kept)!.paneId;
  const lefts: number[] = [];
  const keptWidths = new Set<number>();
  const start = performance.now();
  while (performance.now() - start < 900) {
    await new Promise(requestAnimationFrame);
    const side = harness.container.querySelector(`iframe[title="${other}"]`);
    if (side) lefts.push(Math.round(side.getBoundingClientRect().left));
    keptWidths.add(Math.round(harness.container.querySelector(`iframe[title="${kept}"]`)!.getBoundingClientRect().width));
  }
  expect(new Set(lefts).size, JSON.stringify(lefts)).toBeGreaterThan(5);
  expect(lefts[0], JSON.stringify(lefts)).toBeGreaterThan(800);
  expect(Math.abs(lefts.at(-1)! - 500)).toBeLessThan(2);
  expect(keptWidths.size, [...keptWidths].join(' ')).toBeLessThanOrEqual(2);
});

it('with exit, a last child that goes away is drawn until it is off, moving out over frames', async () => {
  await page.viewport(1100, 800);
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px';
  const cut = (side: boolean) => <TrackCut axis="x" animate exit onShares={() => {}} onEqualize={() => {}} shares={side ? [60, 40] : [100]}
    items={[{ id: 'main', min: 0, node: <div /> }, ...(side ? [{ id: 'side', min: 0, fixed: true, node: <div data-testid="side" style={{ height: '100%' }} /> }] : [])]} />;
  await act(() => harness.render(cut(true)));
  await act(() => harness.render(cut(false)));
  const lefts: number[] = [];
  const start = performance.now();
  while (performance.now() - start < 900) {
    await new Promise(requestAnimationFrame);
    const side = harness.container.querySelector('[data-testid="side"]');
    lefts.push(side ? Math.round(side.getBoundingClientRect().left) : -1);
  }
  expect(lefts[0], JSON.stringify(lefts)).toBeLessThan(700);
  expect(new Set(lefts.filter((left) => left >= 0)).size, JSON.stringify(lefts)).toBeGreaterThan(5);
  expect(lefts.at(-1), JSON.stringify(lefts)).toBe(-1);
});

it('narrowing and widening only change visibility, preserving both panes, tabs and layout shares', async () => {
  await mount();
  const before = JSON.stringify(layout.snapshot);
  harness.container.style.width = '300px';
  await until('the real tree narrows', () => !!harness.container.querySelector('[data-pane-tree-narrow]'));
  expect(harness.container.querySelectorAll('iframe')).toHaveLength(2);
  expect(JSON.stringify(layout.snapshot)).toBe(before);
  harness.container.style.width = '1000px';
  await until('the same tree widens again', () => !harness.container.querySelector('[data-pane-tree-narrow]'));
  expect(JSON.stringify(layout.snapshot)).toBe(before);
});

it('pages that ask for a wider pane are put away sooner, and come back at that width', async () => {
  await mount(360);
  const before = JSON.stringify(layout.snapshot);
  const narrow = () => !!harness.container.querySelector('[data-pane-tree-narrow]');
  harness.container.style.width = '720px';
  await until('two 360px pages and their divider do not fit in 720px', narrow);
  harness.container.style.width = '721px';
  await until('they fit in 721px', () => !narrow());
  expect(JSON.stringify(layout.snapshot)).toBe(before);
});

it('a page shown again after being hidden in a narrow window fills its cell, and both do once widened', async () => {
  await mount();
  const box = (paneId: string) => harness.container.querySelector(`iframe[title="${paneId}"]`)!.parentElement!.getBoundingClientRect();
  const [first, second] = layout.groups.map(({ paneId }) => paneId);
  const pageHeight = 600 - WINDOW_CONTROL_BAR_HEIGHT_PX;
  const fills = (paneId: string, width: number) => { expect(box(paneId).width).toBe(width); expect(box(paneId).height).toBe(pageHeight); };
  harness.container.style.width = '300px';
  await until('the real tree narrows', () => !!harness.container.querySelector('[data-pane-tree-narrow]'));
  for (const paneId of [first, second, first]) {
    await act(async () => layout.setActiveGroup(paneId));
    fills(paneId, 300);
  }
  harness.container.style.width = '1000px';
  await until('the same tree widens again', () => !harness.container.querySelector('[data-pane-tree-narrow]') && box(first).width > 0 && box(second).width > 0);
  expect(box(first).width + box(second).width).toBeGreaterThan(990);
  expect(box(first).height).toBe(pageHeight);
  expect(box(second).height).toBe(pageHeight);
});

it('splitting and closing a pane keep the pane that stays mounted, its page the same node', async () => {
  await page.viewport(1100, 800);
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px';
  const provider = createTabProvider({ kind: 'page', resourceKey: (state: { id: string }) => state.id, initialize: () => ({ dispose() {} }), dispose() {}, TabContent: () => null, TabBarItem: () => null, TabBarItemDragPreview: () => null });
  layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'tree-v3-keep' });
  layout.open('page', { id: 'conversation' }, { from: null, intent: 'newTab' });
  const file = layout.open('page', { id: 'file' }, { from: null, intent: 'newTab' })!;
  layout.focusedPane.setDimensions(harness.container.clientWidth, harness.container.clientHeight);
  const kept = layout.activePaneId;
  const mounts: string[] = [];
  function Page({ id }: { id: string }) {
    useEffect(() => { mounts.push(`mount ${id === kept ? 'kept' : 'other'}`); return () => { mounts.push(`unmount ${id === kept ? 'kept' : 'other'}`); }; }, [id]);
    return <iframe title={id} style={{ width: '100%', height: '100%' }} />;
  }
  await act(() => harness.render(<PaneTreeView layout={layout} renderPane={(id, _first, _last, part) => (part === 'bar' ? null : <Page id={id} />)} />));
  const page0 = harness.container.querySelector(`iframe[title="${kept}"]`);
  await act(() => { expect(layout.splitPane(kept, 'right', file)).toBe(true); });
  const other = layout.groups.find(({ paneId }) => paneId !== kept)!.paneId;
  await until('the kept pane fills the left half', () => harness.container.querySelector(`iframe[title="${kept}"]`)?.getBoundingClientRect().width ?? 0, (width) => Math.abs(width - 499.5) < 2);
  expect(harness.container.querySelector(`iframe[title="${kept}"]`)).toBe(page0);
  await act(() => layout.closePane(other));
  await until('the kept pane fills the tree again', () => harness.container.querySelector(`iframe[title="${kept}"]`)?.getBoundingClientRect().width ?? 0, (width) => width === 1000);
  expect(harness.container.querySelector(`iframe[title="${kept}"]`)).toBe(page0);
  expect(mounts).toEqual(['mount kept', 'mount other', 'unmount other']);
});

it('a page of the pair in full screen keeps the one strip over it, and nothing under it moves', async () => {
  await page.viewport(1100, 800);
  harness = createReactHarness();
  harness.container.style.cssText = `position:fixed;left:0;top:0;width:1000px;height:600px;anchor-name:${WORKSPACE_ANCHOR}`;
  const provider = createTabProvider({ kind: 'page', resourceKey: (state: { id: string }) => state.id, initialize: () => ({ dispose() {} }), dispose() {}, TabContent: () => null, TabBarItem: () => null, TabBarItemDragPreview: () => null });
  layout = new PaneLayoutStore(createTabRegistry([provider]), { viewId: 'tree-v3-full' });
  layout.open('page', { id: 'conversation' }, { from: null, intent: 'newTab' });
  const side = layout.open('page', { id: 'notes.md' }, { from: null, intent: 'newTab' })!;
  layout.focusedPane.setDimensions(1000, 600);
  expect(layout.splitPane(layout.activePaneId, 'right', side)).toBe(true);
  const group = (paneId: string) => layout.groups.find((candidate) => candidate.paneId === paneId)!;
  await act(() => harness.render(<DndContext><PaneTreeView layout={layout} renderPane={(id, _first, _last, part) => (
    <PaneContext.Provider value={{ paneId: id, pane: group(id).pane, isFocusedPane: true }}><PaneContent part={part} /></PaneContext.Provider>
  )} /></DndContext>));
  const strip = () => harness.container.querySelector<HTMLElement>('.session-tab-bar')!;
  await until('the strip is drawn', () => strip()?.getBoundingClientRect().width ?? 0, (width) => width === 1000);
  const row = harness.container.querySelector<HTMLElement>('[data-pane-strip]')!.getBoundingClientRect().height;
  const sidePane = layout.groups.find(({ pane }) => pane.entries.has(side))!.pane;
  expect(strip().querySelector('[data-testid="tab-exit-fullscreen"]')).toBeNull();
  await act(() => sidePane.tabFill(side)!.toggle());
  const cover = harness.container.querySelector<HTMLElement>('[data-tab-fullscreen]')!;
  await until('the page covers the workspace under the strip', () => cover.getBoundingClientRect().width, (width) => width === 1000);
  expect(cover.getBoundingClientRect().top).toBe(strip().getBoundingClientRect().bottom);
  expect(cover.getBoundingClientRect().bottom).toBe(600);
  expect(strip().getBoundingClientRect().top).toBe(0);
  expect(strip().contains(document.elementFromPoint(500, 20))).toBe(true);
  expect(harness.container.querySelectorAll('.session-tab-bar')).toHaveLength(1);
  expect(harness.container.querySelector<HTMLElement>('[data-pane-strip]')!.getBoundingClientRect().height).toBe(row);
  // The strip over a full-screen page offers a worded way out; it is the same exit as the tab's own toggle and Esc.
  const exit = strip().querySelector<HTMLButtonElement>('[data-tabbar-actions] [data-testid="tab-exit-fullscreen"]')!;
  expect(exit.textContent).not.toBe('');
  expect(exit.getAttribute('aria-label')).toBe(exit.textContent);
  await act(() => exit.click());
  expect(tabFullscreen.isOn(sidePane)).toBe(false);
  expect(strip().querySelector('[data-testid="tab-exit-fullscreen"]')).toBeNull();
});
