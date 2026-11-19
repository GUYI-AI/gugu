/**
 * @@@list-clip — folding the list, either way, moves the page with the one spring: in every frame its left edge is on the
 * list's drawn edge and its right edge stays put, so its width follows the motion. A collapse and an expand change the
 * page's layout at the same moments, ❌ one at the start and the other where it lands.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { WorkspaceLayout, WorkspaceContentLayout } from '@renderer/lib/layout/workspace-layout';
import { SIDEBAR_RAIL_PX, WorkspaceLayoutContextProvider, useInnerSidebarFrame, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
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

/** Every frame until the list stops moving: the page's laid-out width, how far its edges are from the list's edge and the shell's right. */
async function foldFrames(shell: HTMLElement) {
  // The list is clipped at its edge, and the edge's handle rides on it.
  const handle = shell.querySelector<HTMLElement>('[data-panel-resize-handle]')!;
  const surface = shell.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
  const frames: { width: number; gap: number; right: number; edge: number }[] = [];
  let still = 0, last = -1;
  await userEvent.click([...shell.querySelectorAll('button')].find((button) => button.textContent === 'toggle list')!);
  while (still < 10) {
    await new Promise(requestAnimationFrame);
    const box = handle.getBoundingClientRect();
    const edge = box.left + box.width / 2;
    const page = surface.getBoundingClientRect();
    frames.push({ width: surface.offsetWidth, gap: page.left - edge, right: shell.getBoundingClientRect().right - page.right, edge });
    still = Math.abs(edge - last) < 0.01 ? still + 1 : 0;
    last = edge;
  }
  return frames;
}

it('a fold moves the page with the list\'s edge in every frame, the same way in both directions', async () => {
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
        <WorkspaceLayout leftSidebar={<div>project list</div>} mainContent={<WorkspaceContentLayout titlebarSlot={null} mainPanel={<Body />} />} />
      </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
    </div>
  );
  const shell = harness.container.querySelector<HTMLElement>('[data-workspace-shell]')!;
  const widthsPerFold: number[] = [];
  for (const direction of ['collapse', 'expand']) {
    const frames = await foldFrames(shell);
    expect(frames.length, `${direction}: the list animated`).toBeGreaterThan(15);
    const gaps = frames.map((frame) => Math.round(frame.gap));
    expect(new Set(gaps).size, `${direction}: the page's left edge follows the list's edge (${gaps.join(',')})`).toBe(1);
    const rights = frames.map((frame) => Math.round(frame.right));
    expect(new Set(rights).size, `${direction}: the page's right edge stays put (${rights.join(',')})`).toBe(1);
    // Neither held at one end nor switched once: the page's width moves through the fold.
    widthsPerFold.push(new Set(frames.map((frame) => frame.width)).size);
    expect(widthsPerFold.at(-1), `${direction}: page widths through the fold`).toBeGreaterThan(5);
  }
});

it('a place without the list takes no space or motion from it after a resize, while folding, or on return', async () => {
  writeInterface('gugu.taskpage.sidebarWidth', 320);
  function InnerColumn() {
    const width = useInnerSidebarFrame();
    return <motion.div data-region="inner-sidebar" className="h-full shrink-0" style={{ width }} />;
  }
  function Places() {
    const [sidebarHidden, setSidebarHidden] = useState(false);
    return <>
      <button style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 100 }} onClick={() => setSidebarHidden(!sidebarHidden)}>switch place</button>
      <WorkspaceLayout sidebarHidden={sidebarHidden} leftSidebar={<div>project list</div>} innerSidebar={<InnerColumn />} mainContent={<WorkspaceContentLayout titlebarSlot={null} mainPanel={<Body />} />} />
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
  const handle = shell.querySelector<HTMLElement>('[data-panel-resize-handle]')!;
  const start = handle.getBoundingClientRect().left + handle.getBoundingClientRect().width / 2;
  pointer('pointerdown', handle, start);
  pointer('pointermove', handle, start + 80);
  pointer('pointerup', handle, start + 80);
  await userEvent.click(button('switch place'));
  await new Promise(requestAnimationFrame);
  expect(shell.firstElementChild!.getBoundingClientRect().width, 'unmounting the group column must not restore the hidden list\'s space').toBe(0);
  expect(surface.getBoundingClientRect().left).toBe(shell.getBoundingClientRect().left);
  await userEvent.click(button('switch place'));
  await expect.poll(() => list.getBoundingClientRect().width).toBe(400);
  for (const landedWidth of [SIDEBAR_RAIL_PX, 400]) {
    await userEvent.click(button('toggle list'));
    await userEvent.click(button('switch place'));
    await new Promise(requestAnimationFrame);
    expect(surface.getBoundingClientRect().left - shell.getBoundingClientRect().left, 'the hidden list must not shift the new page while it is still moving').toBeCloseTo(0);
    expect(surface.getBoundingClientRect().right + parseFloat(getComputedStyle(surface).marginRight), 'the existing surface inset is the only space at the other edge').toBeCloseTo(shell.getBoundingClientRect().right);
    await userEvent.click(button('switch place'));
    await expect.poll(() => list.getBoundingClientRect().width).toBe(landedWidth);
    await expect.poll(() => shell.firstElementChild!.getBoundingClientRect().width).toBe(landedWidth);
    await expect.poll(() => surface.getBoundingClientRect().left - shell.querySelector('[data-region="inner-sidebar"]')!.getBoundingClientRect().right).toBeCloseTo(0);
    expect(shell.querySelector('aside'), 'returning keeps the same list').toBe(list);
  }
});

/** A mouse drag on the list's edge, one move a frame (pointer 1 is the mouse, so pointer capture takes it). */
function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', target: HTMLElement, clientX: number) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX, clientY: 200 }));
}

it('dragging the rail\'s edge out moves the page with it; let go, it lands the same way a click fold does', async () => {
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
  const rightOf = () => Math.round(shell.getBoundingClientRect().right - surface.getBoundingClientRect().right);
  const right = rightOf();
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
  expect(widths.at(-1)!, 'mid-drag the page narrows with the edge').toBeLessThan(railWidth - 80);
  expect(rightOf(), 'and keeps its right edge').toBe(right);
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
  expect(new Set(frames.map((frame) => frame.width)).size, 'the page moved with the edge on the way').toBeGreaterThan(5);
  expect(rightOf(), 'and kept its right edge').toBe(right);
});
