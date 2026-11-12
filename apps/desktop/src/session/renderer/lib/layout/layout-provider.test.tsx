// @vitest-environment jsdom
// GUYI-AI/gugu#2548 the sidebar starts expanded, and as one list it collapses to a rail of avatars instead of away.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Reduced motion lands every collapse on its end value at once, so the widths below are read without waiting on a spring.
vi.mock('framer-motion', async (importOriginal) => ({ ...(await importOriginal<typeof import('framer-motion')>()), useReducedMotion: () => true }));

const {
  sidebarEdgeDrag,
  sidebarEdgeSnapsOpen,
  sidebarOccupiedWidth,
  sidebarRailBadgeOpacity,
  sidebarRailLayout,
  sidebarRailTextOpacity,
  useWorkspaceLayoutService,
  SIDEBAR_DEFAULT_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  SIDEBAR_RAIL_LAYOUT_BELOW,
} = await import('./layout-provider');

let layout: ReturnType<typeof useWorkspaceLayoutService>;
function Probe() {
  layout = useWorkspaceLayoutService();
  return null;
}
let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const mount = () => act(async () => root.render(<Probe />));
/** Hover the collapse button past the peek delay (PEEK_TRIGGER_HOVER_MS = 100). */
const hoverToggle = () => act(async () => {
  layout.setTriggerHovered(true);
  await new Promise((resolve) => setTimeout(resolve, 150));
});

describe('the sidebar starts expanded', () => {
  it('opens on every start; only the width is stored, and a stored width wins over the default', async () => {
    localStorage.setItem('gugu.taskpage.sidebarWidth', '300');
    await mount();
    expect(layout.isLeftOpen).toBe(true);
    expect(layout.leftAnimatedWidth.get()).toBe(300);
  });

  it('starts at the default width when nothing is stored', async () => {
    await mount();
    expect(layout.isLeftOpen).toBe(true);
    expect(layout.leftAnimatedWidth.get()).toBe(SIDEBAR_DEFAULT_WIDTH_PX);
  });
});

describe('collapsing', () => {
  it('without a rail the sidebar goes away and peeks out on hover (today)', async () => {
    await mount();
    await act(async () => layout.setCollapsed('left', true, { suppressPeek: false }));
    expect(layout.isLeftOpen).toBe(false);
    expect(layout.leftAnimatedWidth.get()).toBe(0);
    await hoverToggle();
    expect(layout.isLeftPeeking).toBe(true);
  });

  it('with a rail it stays that wide, and there is nothing to peek at', async () => {
    await mount();
    await act(async () => layout.setLeftRail(72));
    expect(layout.leftAnimatedWidth.get()).toBe(SIDEBAR_DEFAULT_WIDTH_PX);
    await act(async () => layout.setCollapsed('left', true, { suppressPeek: false }));
    expect(layout.leftAnimatedWidth.get()).toBe(72);
    await hoverToggle();
    expect(layout.isLeftPeeking).toBe(false);
    await act(async () => layout.toggleLeft());
    expect(layout.isLeftOpen).toBe(true);
    expect(layout.leftAnimatedWidth.get()).toBe(SIDEBAR_DEFAULT_WIDTH_PX);
  });

  it('the occupied width runs from the rail to the full width with the same spring progress', () => {
    expect(sidebarOccupiedWidth(0, 240, 72)).toBe(72);
    expect(sidebarOccupiedWidth(0.5, 240, 72)).toBe(156);
    expect(sidebarOccupiedWidth(1, 240, 72)).toBe(240);
    expect(sidebarOccupiedWidth(0.5, 240, 0)).toBe(120);
  });

  it('on the rail the text shows only in the second half of that progress: it fades out first when collapsing, in last when expanding', () => {
    expect([0, 0.25, 0.5, 0.75, 1].map(sidebarRailTextOpacity)).toEqual([0, 0, 0, 0.5, 1]);
  });
});

describe('the rail\'s corner badge moves with the same progress', () => {
  it('fades in near the end of collapsing and out first when expanding', () => {
    expect([1, 0.5, 0.4].map(sidebarRailBadgeOpacity)).toEqual([0, 0, 0]);
    expect(sidebarRailBadgeOpacity(0.2)).toBeCloseTo(0.6);
    expect([0.05, 0].map(sidebarRailBadgeOpacity)).toEqual([1, 1]);
  });

  it('the count changes place (row end ↔ avatar corner) where neither the text nor the badge can be seen', () => {
    expect(sidebarRailLayout(1)).toBe(false);
    expect(sidebarRailLayout(0.5)).toBe(false);
    expect(sidebarRailLayout(0)).toBe(true);
    for (const p of [SIDEBAR_RAIL_LAYOUT_BELOW - 0.04, SIDEBAR_RAIL_LAYOUT_BELOW, SIDEBAR_RAIL_LAYOUT_BELOW + 0.04]) {
      expect(sidebarRailTextOpacity(p)).toBe(0);
      expect(sidebarRailBadgeOpacity(p)).toBe(0);
    }
  });
});

describe('dragging the edge of a sidebar that collapses to a rail', () => {
  const bounds = { rail: 72, min: 200, max: 520 };

  it('at or above the minimum width it is a resize, capped by the maximum', () => {
    expect(sidebarEdgeDrag(300, bounds)).toEqual({ width: 300, progress: 1 });
    expect(sidebarEdgeDrag(200, bounds)).toEqual({ width: 200, progress: 1 });
    expect(sidebarEdgeDrag(900, bounds)).toEqual({ width: 520, progress: 1 });
    // A window too small for the minimum keeps the minimum (as the old handle did).
    expect(sidebarEdgeDrag(300, { ...bounds, max: 150 })).toEqual({ width: 200, progress: 1 });
  });

  it('below it the sidebar follows the pointer: the width rests at the minimum and the progress carries the rest', () => {
    expect(sidebarEdgeDrag(136, bounds)).toEqual({ width: 200, progress: 0.5 });
    expect(sidebarEdgeDrag(72, bounds)).toEqual({ width: 200, progress: 0 });
    expect(sidebarEdgeDrag(10, bounds)).toEqual({ width: 200, progress: 0 });
    for (const raw of [80, 136, 199]) {
      const { width, progress } = sidebarEdgeDrag(raw, bounds);
      expect(sidebarOccupiedWidth(progress, width, bounds.rail)).toBeCloseTo(raw);
    }
  });

  it('letting go snaps to the nearer state', () => {
    expect(sidebarEdgeSnapsOpen(1)).toBe(true);
    expect(sidebarEdgeSnapsOpen(0.5)).toBe(true);
    expect(sidebarEdgeSnapsOpen(0.49)).toBe(false);
    expect(sidebarEdgeSnapsOpen(0)).toBe(false);
  });

  // What the occupied width (a transform of these two) reads on the next frame; mid-drag nothing re-renders.
  const occupied = () => sidebarOccupiedWidth(layout.leftProgress.get(), layout.leftWidth.get(), 72);
  const railed = async () => {
    localStorage.setItem('gugu.taskpage.sidebarWidth', '300');
    await mount();
    await act(async () => layout.setLeftRail(72));
  };

  it('mid-drag nothing collapses: the edge stays where the pointer is, open until the release', async () => {
    await railed();
    await act(async () => layout.dragLeftEdge(90, Number.POSITIVE_INFINITY));
    expect(layout.isLeftOpen).toBe(true);
    expect(occupied()).toBeCloseTo(90);
    await act(async () => layout.dragLeftEdge(250, Number.POSITIVE_INFINITY));
    expect(occupied()).toBe(250);
  });

  it('released nearer the rail it collapses, and the next open comes back at the width the drag started from', async () => {
    await railed();
    await act(async () => layout.dragLeftEdge(120, Number.POSITIVE_INFINITY));
    await act(async () => layout.releaseLeftEdge());
    expect(layout.isLeftOpen).toBe(false);
    expect(occupied()).toBe(72);
    expect(localStorage.getItem('gugu.taskpage.sidebarWidth')).toBe('300');
    await act(async () => layout.toggleLeft());
    expect(layout.isLeftOpen).toBe(true);
    expect(occupied()).toBe(300);
  });

  it('released nearer the minimum width it stays open there, and that width is stored', async () => {
    await railed();
    await act(async () => layout.dragLeftEdge(170, Number.POSITIVE_INFINITY));
    await act(async () => layout.releaseLeftEdge());
    expect(layout.isLeftOpen).toBe(true);
    expect(occupied()).toBe(SIDEBAR_MIN_WIDTH_PX);
    expect(localStorage.getItem('gugu.taskpage.sidebarWidth')).toBe(String(SIDEBAR_MIN_WIDTH_PX));
  });

  it('dragging the collapsed rail\'s edge out opens it; a small pull snaps back to the rail', async () => {
    await railed();
    await act(async () => layout.setCollapsed('left', true));
    await act(async () => layout.dragLeftEdge(100, Number.POSITIVE_INFINITY));
    await act(async () => layout.releaseLeftEdge());
    expect(layout.isLeftOpen).toBe(false);
    expect(occupied()).toBe(72);
    await act(async () => layout.dragLeftEdge(280, Number.POSITIVE_INFINITY));
    expect(layout.isLeftOpen).toBe(false);
    expect(occupied()).toBe(280);
    await act(async () => layout.releaseLeftEdge());
    expect(layout.isLeftOpen).toBe(true);
    expect(occupied()).toBe(280);
  });

  it('pressing the edge and letting go without moving changes nothing', async () => {
    await railed();
    await act(async () => layout.releaseLeftEdge());
    expect(layout.isLeftOpen).toBe(true);
    expect(occupied()).toBe(300);
  });
});
