// @vitest-environment jsdom
// GUYI-AI/gugu#2548 the sidebar starts expanded, and as one list it collapses to a rail of avatars instead of away.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Reduced motion lands every collapse on its end value at once, so the widths below are read without waiting on a spring.
vi.mock('framer-motion', async (importOriginal) => ({ ...(await importOriginal<typeof import('framer-motion')>()), useReducedMotion: () => true }));

const { sidebarOccupiedWidth, sidebarRailTextOpacity, useWorkspaceLayoutService, SIDEBAR_DEFAULT_WIDTH_PX } = await import('./layout-provider');

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
