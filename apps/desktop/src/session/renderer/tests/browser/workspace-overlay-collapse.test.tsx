/**
 * @@@overlay-collapse — folding the list moves it over the page: the page is laid out at most twice per fold (at the start
 * of a collapse, where an expand lands), not in every frame, its left edge stays on the list's edge all the way, and the
 * re-layout of an expand comes with the frame the edge lands in (SIDEBAR_LANDED_PX), ❌ after the spring's sub-pixel tail.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useState } from 'react';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { WorkspaceLayout, WorkspaceContentLayout } from '@renderer/lib/layout/workspace-layout';
import { SIDEBAR_LANDED_PX, SIDEBAR_RAIL_PX, WorkspaceLayoutContextProvider, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { sidebarFolds } from '@renderer/features/sidebar/sidebar-folds';
import { writeInterface } from '@/lib/viewStateTable';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', async (original) => ({ ...(await original<object>()), ShellSidebarToggle: () => null }));

let harness: ReturnType<typeof createReactHarness>;
function Body() {
  const { toggleLeft } = useWorkspaceLayoutContext();
  return <><button onClick={toggleLeft}>toggle list</button>{Array.from({ length: 300 }, (_, i) => <p key={i}>line {i} of a page that wraps differently at every width it is given</p>)}</>;
}
beforeEach(async () => { await page.viewport(1200, 800); localStorage.removeItem('gugu.taskpage.sidebarWidth'); });
// A drag that lands open stores its width: ❌ leave it for the next file's list.
afterEach(() => { harness?.cleanup(); sidebarFolds.clear(); writeInterface('gugu.taskpage.sidebarWidth', undefined); });

/** Every frame until the list stops moving: the page's laid-out width, and how far its left edge is from the list's edge. */
async function foldFrames(shell: HTMLElement) {
  // The list is clipped at its edge, and the edge's handle rides on it.
  const handle = shell.querySelector<HTMLElement>('[data-panel-resize-handle]')!;
  const surface = shell.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
  const frames: { width: number; gap: number; edge: number }[] = [];
  let still = 0, last = -1;
  await userEvent.click([...shell.querySelectorAll('button')].find((button) => button.textContent === 'toggle list')!);
  while (still < 10) {
    await new Promise(requestAnimationFrame);
    const box = handle.getBoundingClientRect();
    const edge = box.left + box.width / 2;
    frames.push({ width: surface.offsetWidth, gap: surface.getBoundingClientRect().left - edge, edge });
    still = Math.abs(edge - last) < 0.01 ? still + 1 : 0;
    last = edge;
  }
  return frames;
}

it('a fold lays the page out at most twice and keeps it on the list\'s edge, both ways', async () => {
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
        <WorkspaceLayout leftSidebar={<div>project list</div>} mainContent={<WorkspaceContentLayout titlebarSlot={null} mainPanel={<Body />} />} />
      </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
    </div>
  );
  const shell = harness.container.querySelector<HTMLElement>('[data-workspace-shell]')!;
  for (const direction of ['collapse', 'expand']) {
    const frames = await foldFrames(shell);
    expect(frames.length, `${direction}: the list animated`).toBeGreaterThan(15);
    expect(new Set(frames.map((frame) => frame.width)).size, `${direction}: page widths`).toBeLessThanOrEqual(2);
    const gaps = frames.map((frame) => Math.round(frame.gap));
    expect(new Set(gaps).size, `${direction}: the page's left edge follows the list's edge (${gaps.join(',')})`).toBe(1);
    // The page's width changes with the frame the edge lands in: at the start of a collapse, ❌ after the expand's tail.
    const end = frames.at(-1)!;
    const landed = frames.findIndex((frame) => Math.abs(frame.edge - end.edge) < SIDEBAR_LANDED_PX);
    const relaid = frames.findIndex((frame) => frame.width === end.width);
    if (direction === 'collapse') expect(relaid, 'collapse: laid out at the rail at once').toBeLessThanOrEqual(1);
    else expect(relaid - landed, `expand: re-laid out ${relaid - landed} frames after the edge landed`).toBeLessThanOrEqual(1);
  }
});

it('leaving a folding list gives a place without that list the whole width, and returning preserves the fold', async () => {
  writeInterface('gugu.taskpage.sidebarWidth', 320);
  function Places() {
    const [sidebarHidden, setSidebarHidden] = useState(false);
    return <>
      <button style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 100 }} onClick={() => setSidebarHidden(!sidebarHidden)}>switch place</button>
      <WorkspaceLayout sidebarHidden={sidebarHidden} leftSidebar={<div>project list</div>} mainContent={<WorkspaceContentLayout titlebarSlot={null} mainPanel={<Body />} />} />
    </>;
  }
  harness = createReactHarness();
  await harness.render(<div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
    <SessionLocalizationProvider><WorkspaceLayoutContextProvider><Places /></WorkspaceLayoutContextProvider></SessionLocalizationProvider>
  </div>);
  const shell = harness.container.querySelector<HTMLElement>('[data-workspace-shell]')!;
  const surface = shell.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
  const list = shell.querySelector<HTMLElement>('aside')!;
  const button = (label: string) => [...harness.container.querySelectorAll('button')].find(button => button.textContent === label)!;
  for (const landedWidth of [SIDEBAR_RAIL_PX, 320]) {
    await userEvent.click(button('toggle list'));
    await userEvent.click(button('switch place'));
    await new Promise(requestAnimationFrame);
    expect(surface.getBoundingClientRect().left - shell.getBoundingClientRect().left, 'the hidden list must not shift the new page while it is still moving').toBeCloseTo(0);
    expect(surface.getBoundingClientRect().right + parseFloat(getComputedStyle(surface).marginRight), 'the existing surface inset is the only space at the other edge').toBeCloseTo(shell.getBoundingClientRect().right);
    await userEvent.click(button('switch place'));
    await expect.poll(() => list.getBoundingClientRect().width).toBe(landedWidth);
    await expect.poll(() => surface.getBoundingClientRect().left - shell.getBoundingClientRect().left).toBeCloseTo(landedWidth);
    expect(shell.querySelector('aside'), 'returning keeps the same list').toBe(list);
  }
});

/** A mouse drag on the list's edge, one move a frame (pointer 1 is the mouse, so pointer capture takes it). */
function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', target: HTMLElement, clientX: number) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX, clientY: 200 }));
}

it('dragging the rail\'s edge out moves the list over a page laid out at the rail; let go, it lands in one re-layout', async () => {
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
        <WorkspaceLayout leftSidebar={<div>project list</div>} mainContent={<WorkspaceContentLayout titlebarSlot={null} mainPanel={<Body />} />} />
      </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
    </div>
  );
  const shell = harness.container.querySelector<HTMLElement>('[data-workspace-shell]')!;
  await foldFrames(shell); // to the rail
  const handle = shell.querySelector<HTMLElement>('[data-panel-resize-handle]')!;
  const surface = shell.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
  const railWidth = surface.offsetWidth;
  const start = handle.getBoundingClientRect().left + handle.getBoundingClientRect().width / 2;
  pointer('pointerdown', handle, start);
  const widths: number[] = [];
  const gaps = new Set<number>();
  // Out to past half way to the minimum width (200): below it the drag is the fold, not a resize.
  for (let x = 4; x <= 100; x += 8) {
    pointer('pointermove', handle, start + x);
    await new Promise(requestAnimationFrame);
    widths.push(surface.offsetWidth);
    const box = handle.getBoundingClientRect();
    gaps.add(Math.round(surface.getBoundingClientRect().left - (box.left + box.width / 2)));
  }
  expect(new Set(widths), 'mid-drag the page keeps its rail layout').toEqual(new Set([railWidth]));
  expect(gaps.size, `the page rides on the edge (${[...gaps].join(',')})`).toBe(1);
  pointer('pointerup', handle, start + 100);
  const frames: { width: number; edge: number }[] = [];
  let still = 0, last = -1;
  while (still < 10) {
    await new Promise(requestAnimationFrame);
    const box = handle.getBoundingClientRect();
    frames.push({ width: surface.offsetWidth, edge: box.left + box.width / 2 });
    still = Math.abs(frames.at(-1)!.edge - last) < 0.01 ? still + 1 : 0;
    last = frames.at(-1)!.edge;
  }
  const end = frames.at(-1)!;
  expect(end.width, 'it snapped open').toBeLessThan(railWidth);
  expect(new Set(frames.map((frame) => frame.width)).size, 'one re-layout on the way').toBeLessThanOrEqual(2);
  const landed = frames.findIndex((frame) => Math.abs(frame.edge - end.edge) < SIDEBAR_LANDED_PX);
  const relaid = frames.findIndex((frame) => frame.width === end.width);
  expect(relaid - landed, `re-laid out ${relaid - landed} frames after the edge landed`).toBeLessThanOrEqual(1);
});
