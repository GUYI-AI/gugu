/**
 * @@@list-clip — folding the list, either way, moves the page with the one spring (panel-track): in every frame its left
 * edge is on the list's drawn edge and it is laid out at the width that leaves it — the size is the state, ❌ one layout
 * under a transform.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { WorkspaceLayout, WorkspaceContentLayout } from '@renderer/lib/layout/workspace-layout';
import { INNER_SIDEBAR_MAX_SHARE, INNER_SIDEBAR_MAX_WIDTH_PX, SIDEBAR_RAIL_PX, WorkspaceLayoutContextProvider, useInnerSidebarFrame, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
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

const edgeOf = (handle: HTMLElement) => handle.getBoundingClientRect().left + handle.getBoundingClientRect().width / 2;

/**
 * The frames of one motion of the list's edge away from `from` (where it was before the click or the release): from the
 * first frame it is a pixel away until it has been still for 10 frames. How many frames that is, and whether any is
 * caught mid-way, is the machine's: a loaded runner may start late or draw the whole motion between two of our frames.
 */
async function edgeMotion<T>(handle: HTMLElement, from: number, read: (edge: number) => T): Promise<T[]> {
  const frames: T[] = [];
  let still = 0, last = from;
  while (still < 10) {
    await new Promise(requestAnimationFrame);
    const edge = edgeOf(handle);
    if (frames.length === 0 && Math.abs(edge - from) < 1) continue;
    frames.push(read(edge));
    still = Math.abs(edge - last) < 0.01 ? still + 1 : 0;
    last = edge;
  }
  return frames;
}

/** Where the fold starts, then each frame of it: the page's laid-out width, how far its edges are from the list's edge and the shell's right. */
async function foldFrames(shell: HTMLElement) {
  // The list is clipped at its edge, and the edge's handle rides on it.
  const handle = shell.querySelector<HTMLElement>('[data-panel-resize-handle]')!;
  const surface = shell.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
  const before = { width: surface.offsetWidth, edge: edgeOf(handle), right: shell.getBoundingClientRect().right - surface.getBoundingClientRect().right };
  await userEvent.click([...shell.querySelectorAll('button')].find((button) => button.textContent === 'toggle list')!);
  const frames = await edgeMotion(handle, before.edge, (edge) => {
    const page = surface.getBoundingClientRect();
    return { width: surface.offsetWidth, gap: page.left - edge, right: shell.getBoundingClientRect().right - page.right, edge };
  });
  return { before, frames };
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
  const folds: { before: { width: number; edge: number }; end: { width: number; edge: number } }[] = [];
  for (const direction of ['collapse', 'expand'] as const) {
    const { before, frames } = await foldFrames(shell);
    const end = frames.at(-1)!;
    folds.push({ before, end });
    const gaps = frames.map((frame) => Math.round(frame.gap));
    expect(new Set(gaps).size, `${direction}: the page's left edge follows the list's edge (${gaps.join(',')})`).toBe(1);
    expect(frames.every((frame) => frame.right <= Math.round(before.right) + 0.5), `${direction}: the page always reaches the shell's right edge`).toBe(true);
    // Laid out in every frame: its width follows the list's edge, and it ends on the shell's right edge the whole way.
    const widths = [before.width, ...frames.map((frame) => frame.width)];
    expect(new Set(widths).size, `${direction}: the page is laid out at each width (${widths.join(',')})`).toBeGreaterThan(5);
    expect(frames.every((frame) => Math.abs(frame.right - before.right) < 1), `${direction}: the page ends on the shell's right edge`).toBe(true);
    // One way, no jump back: the list's edge only moves toward where it lands.
    const edges = frames.map((frame) => frame.edge);
    const step = direction === 'collapse' ? -1 : 1;
    expect(edges.every((edge, i) => i === 0 || (edge - edges[i - 1]) * step >= -0.01), `${direction}: the edge moves one way (${edges.map(Math.round).join(',')})`).toBe(true);
  }
  // The expand lands where the collapse started: back at the list's width.
  const [collapse, expand] = folds;
  expect(Math.round(expand.end.edge)).toBe(Math.round(collapse.before.edge));
  expect(expand.end.width).toBe(collapse.before.width);
  expect(collapse.before.edge - collapse.end.edge, 'the collapse moved the edge').toBeGreaterThan(0);
});

function InnerColumn() {
  useInnerSidebarFrame();
  return <div data-region="inner-sidebar" className="h-full w-full" />;
}

it('the inner column\'s widest is a share of the card beside the list\'s place, so folding the list lets it grow', async () => {
  writeInterface('gugu.taskpage.sidebarWidth', 320);
  harness = createReactHarness();
  await harness.render(<div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
    <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
      <WorkspaceLayout leftSidebar={<div>project list</div>} innerSidebar={<InnerColumn />} mainContent={<WorkspaceContentLayout titlebarSlot={null} mainPanel={<Body />} />} />
    </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
  </div>);
  const shell = harness.container.querySelector<HTMLElement>('[data-workspace-shell]')!;
  const column = () => shell.querySelector<HTMLElement>('[data-region="inner-sidebar"]')!.getBoundingClientRect().width;
  const dragInnerEdgeFar = async () => {
    const handle = await vi.waitFor(() => shell.querySelectorAll<HTMLElement>('[data-panel-resize-handle]')[1]!);
    const start = edgeOf(handle);
    pointer('pointerdown', handle, start);
    pointer('pointermove', handle, start + 900);
    pointer('pointerup', handle, start + 900);
  };
  const widest = (listPlace: number) => Math.min(INNER_SIDEBAR_MAX_WIDTH_PX, (shell.getBoundingClientRect().width - listPlace) * INNER_SIDEBAR_MAX_SHARE);
  await dragInnerEdgeFar();
  await expect.poll(column, { message: 'beside the expanded list' }).toBeCloseTo(widest(320), 0);
  await foldFrames(shell);
  await dragInnerEdgeFar();
  await expect.poll(column, { message: 'beside the rail: the card is wider, so is its share' }).toBeCloseTo(widest(SIDEBAR_RAIL_PX), 0);
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
  const released = edgeOf(handle);
  pointer('pointerup', handle, start + 100);
  const snap = await edgeMotion(handle, released, (edge) => ({ width: surface.offsetWidth, gap: Math.round(surface.getBoundingClientRect().left - edge) }));
  expect(snap.at(-1)!.width, 'it snapped open').toBeLessThan(railWidth);
  expect(new Set(snap.map((frame) => frame.gap)).size, `the page rode on the edge as it snapped (${snap.map((frame) => frame.gap).join(',')})`).toBe(1);
  expect(rightOf(), 'and kept its right edge').toBe(right);
});
