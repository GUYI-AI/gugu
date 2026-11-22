import { afterEach, expect, it, vi } from 'vitest';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';

const disposed = vi.fn();
const registry = createTabRegistry([createTabProvider({
  kind: 'page',
  resourceKey: (state: { id: string }) => state.id,
  initialize: () => ({ dispose() {} }),
  dispose: (_entry, _resource) => disposed(),
  TabBarItem: () => null,
  TabBarItemDragPreview: () => null,
  TabContent: () => null,
})]);
const newTab = { from: null, intent: 'newTab' } as const;
const layouts: PaneLayoutStore[] = [];

afterEach(() => {
  layouts.splice(0).forEach((layout) => layout.dispose());
  disposed.mockClear();
});

/** Two pages side by side; the right one's pane holds only its tab. */
function pair() {
  const layout = new PaneLayoutStore(registry, { viewId: 'closing' });
  layouts.push(layout);
  layout.setDimensions(1200, 800);
  layout.open('page', { id: 'chat' }, newTab);
  const file = layout.open('page', { id: 'file' }, newTab)!;
  expect(layout.splitPane(layout.activePaneId, 'right', file)).toBe(true);
  const side = layout.groups.find(({ pane }) => pane.entries.has(file))!;
  return { layout, file, side };
}

it('without a view moving the cut, closing a pane\'s last tab closes the pane at once', () => {
  const { layout, file, side } = pair();
  side.pane.closeTab(file);
  expect(layout.groups).toHaveLength(1);
  expect(disposed).toHaveBeenCalledOnce();
});

it('with one, the pane stays — page live, out of the strip, focus moved on — until the view lands', () => {
  const { layout, file, side } = pair();
  const detach = layout.attachMotion();
  side.pane.closeTab(file);
  expect(layout.closingPaneId).toBe(side.paneId);
  expect(layout.groups).toHaveLength(2);
  expect(side.pane.entries.has(file)).toBe(true);
  expect(disposed).not.toHaveBeenCalled();
  expect(layout.activePaneId).not.toBe(side.paneId);
  expect(layout.stripTabIds).not.toContain(file);
  layout.panesLanded();
  expect(layout.closingPaneId).toBeUndefined();
  expect(layout.groups).toHaveLength(1);
  expect(disposed).toHaveBeenCalledOnce();
  detach();
});

it('anything else that changes the panes first finishes the close, as does the view going away', () => {
  const { layout, file, side } = pair();
  const detach = layout.attachMotion();
  side.pane.closeTab(file);
  layout.open('page', { id: 'other' }, newTab);
  expect(layout.closingPaneId).toBeUndefined();
  expect(layout.groups.some(({ paneId }) => paneId === side.paneId)).toBe(false);
  const next = pair();
  const stop = next.layout.attachMotion();
  next.side.pane.closeTab(next.file);
  stop();
  expect(next.layout.groups).toHaveLength(1);
  detach();
});
