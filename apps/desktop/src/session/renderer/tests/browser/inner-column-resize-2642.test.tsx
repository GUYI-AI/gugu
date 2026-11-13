import { motion } from 'framer-motion';
import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { WorkspaceLayout, WorkspaceContentLayout } from '@renderer/lib/layout/workspace-layout';
import {
  INNER_SIDEBAR_DEFAULT_WIDTH_PX,
  INNER_SIDEBAR_MIN_WIDTH_PX,
  INNER_SIDEBAR_WIDTH_STORAGE_KEY,
  useInnerSidebarFrame,
  WorkspaceLayoutContextProvider,
} from '@renderer/lib/layout/layout-provider';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

/**
 * GUYI-AI/gugu#2642 the inner column (a group's / project's agents and topics, between the one list and the content) is
 * resized by dragging its right edge, with the same handle as the list's edge: the line only on hover, live while dragging,
 * stored on release under its own key, arrow keys step it. It stops at its minimum (no collapse mid-drag: the column has
 * its own fold button) and never takes more than 40% of the card it shares with the content.
 */

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', async (original) => ({ ...(await original<object>()), ShellSidebarToggle: () => null }));

const LIST_KEY = 'gugu.taskpage.sidebarWidth';

/** The column as InnerSidebarFrame draws it: its width from the layout, reported while it is drawn. */
function InnerColumn() {
  const width = useInnerSidebarFrame();
  return (
    <motion.div
      data-region="inner-sidebar"
      className="relative isolate flex h-full shrink-0 flex-col border-r border-border bg-background"
      style={{ width }}
    >
      <span>群里的智能体与话题</span>
    </motion.div>
  );
}

/** Folding the column unmounts it, as InnerSidebar does. */
const columnShown = observable.box(true);
const FoldableColumn = observer(() => (columnShown.get() ? <InnerColumn /> : null));

let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await page.viewport(1100, 700);
  localStorage.removeItem(LIST_KEY);
  localStorage.removeItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY);
  runInAction(() => columnShown.set(true));
  document.documentElement.dataset.platform = 'mac';
  document.documentElement.dataset.theme = 'light';
});
afterEach(() => {
  harness?.cleanup();
  localStorage.removeItem(LIST_KEY);
  localStorage.removeItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY);
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.theme;
});

async function renderWorkspace({ inner = true }: { inner?: boolean } = {}) {
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
        <WorkspaceLayout
          leftSidebar={<div>one list</div>}
          innerSidebar={inner ? <FoldableColumn /> : null}
          mainContent={
            <WorkspaceContentLayout
              titlebarSlot={
                <TabStripShell>
                  <TabSlot><TabChip isActive isFocusedPane label="产品讨论群" /></TabSlot>
                </TabStripShell>
              }
              mainPanel={<div>reading surface</div>}
            />
          }
        />
      </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
    </div>
  );
  const q = <T extends HTMLElement>(selector: string) => harness.container.querySelector<T>(selector);
  return {
    column: () => q('[data-region="inner-sidebar"]'),
    surface: () => q('[data-workspace-content-surface]')!,
    list: () => q('[data-workspace-left-panel]')!,
    handles: () => [...harness.container.querySelectorAll<HTMLElement>('[data-panel-resize-handle]')],
    guards: () => [...harness.container.querySelectorAll<HTMLElement>('[data-panel-resize-drag-guard]')],
    innerHandle: () => harness.container.querySelectorAll<HTMLElement>('[data-panel-resize-handle]')[1] ?? null,
  };
}

const width = (element: HTMLElement) => element.getBoundingClientRect().width;
const centreX = (element: HTMLElement) => {
  const box = element.getBoundingClientRect();
  return box.left + box.width / 2;
};

/** A mouse drag on the handle, one move at a time (pointer 1 is the mouse, so pointer capture takes it). */
function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', target: HTMLElement, clientX: number) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX, clientY: 200 }));
}

it('without an inner column only the list has a handle', async () => {
  const ui = await renderWorkspace({ inner: false });
  expect(ui.handles()).toHaveLength(1);
  expect(ui.guards()).toHaveLength(1);
});

it('the column\'s right edge has a handle like the list\'s: a 4px separator on the edge, focusable, labelled, line only on hover', async () => {
  const ui = await renderWorkspace();
  const column = ui.column()!;
  expect(width(column), 'nobody who never dragged sees a change').toBe(INNER_SIDEBAR_DEFAULT_WIDTH_PX);
  expect(ui.handles()).toHaveLength(2);
  const [listHandle, handle] = ui.handles();
  expect(handle.getAttribute('role')).toBe('separator');
  expect(handle.getAttribute('aria-orientation')).toBe('vertical');
  expect(handle.getAttribute('aria-label')).toMatch(/内层栏|inner sidebar/i);
  expect(handle.getAttribute('aria-label')).not.toBe(listHandle.getAttribute('aria-label'));
  expect(handle.tabIndex).toBe(0);
  expect(width(handle)).toBe(4);
  expect(centreX(handle), 'it rides on the column\'s right edge').toBeCloseTo(column.getBoundingClientRect().right);
  expect(getComputedStyle(handle).cursor).toBe('col-resize');
  // Same look as the list's handle: nothing at rest, the thin line on hover.
  expect(handle.className).toBe(listHandle.className);
  expect(getComputedStyle(handle).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  await userEvent.hover(handle);
  await expect.poll(() => getComputedStyle(handle).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  // Real hit testing on both halves of the strip: the handle takes the pointer, not the column or the tab strip.
  const box = handle.getBoundingClientRect();
  for (const x of [box.left + 0.5, box.right - 0.5]) {
    expect(document.elementFromPoint(x, ui.surface().getBoundingClientRect().top + 10)).toBe(handle);
    expect(document.elementFromPoint(x, 400)).toBe(handle);
  }
});

it('dragging resizes the column live; the width is stored on release under its own key', async () => {
  const ui = await renderWorkspace();
  const handle = ui.innerHandle()!;
  const start = centreX(handle);
  pointer('pointerdown', handle, start);
  pointer('pointermove', handle, start + 60);
  await expect.poll(() => width(ui.column()!)).toBe(300);
  expect(ui.surface().getBoundingClientRect().left, 'the content gives way at once').toBeCloseTo(ui.column()!.getBoundingClientRect().right);
  expect(centreX(handle), 'the handle moves with the edge').toBeCloseTo(ui.column()!.getBoundingClientRect().right);
  expect(localStorage.getItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY), 'nothing is stored mid-drag').toBeNull();
  pointer('pointerup', handle, start + 60);
  expect(localStorage.getItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY)).toBe('300');
  expect(localStorage.getItem(LIST_KEY), 'the list keeps its own width').toBeNull();
  expect(width(ui.list())).toBe(240);
});

it('dragging past the minimum stops there (no collapse); past the cap it stops at 40% of the card', async () => {
  const ui = await renderWorkspace();
  const handle = ui.innerHandle()!;
  const start = centreX(handle);
  pointer('pointerdown', handle, start);
  pointer('pointermove', handle, start - 500);
  await expect.poll(() => width(ui.column()!)).toBe(INNER_SIDEBAR_MIN_WIDTH_PX);
  pointer('pointerup', handle, start - 500);
  expect(ui.column(), 'the column is still there').not.toBeNull();
  expect(localStorage.getItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(INNER_SIDEBAR_MIN_WIDTH_PX));

  // 1100 wide, list 240: the card is 860, 40% of it is 344.
  const again = centreX(handle);
  pointer('pointerdown', handle, again);
  pointer('pointermove', handle, again + 800);
  await expect.poll(() => width(ui.column()!)).toBe(344);
  pointer('pointerup', handle, again + 800);
  expect(localStorage.getItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY)).toBe('344');
  const card = ui.surface().getBoundingClientRect().right - ui.column()!.getBoundingClientRect().left;
  expect(width(ui.surface()) / card, 'the content keeps at least 60% of the card').toBeGreaterThanOrEqual(0.6 - 0.01);
});

it('arrow keys step it by 16 and store it, even two presses within one frame', async () => {
  const ui = await renderWorkspace();
  const handle = ui.innerHandle()!;
  handle.focus();
  await userEvent.keyboard('{ArrowRight}');
  await expect.poll(() => width(ui.column()!)).toBe(INNER_SIDEBAR_DEFAULT_WIDTH_PX + 16);
  expect(localStorage.getItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(INNER_SIDEBAR_DEFAULT_WIDTH_PX + 16));
  // The drawn width is a transform that catches up on the next frame; the second press must not read the old one.
  const press = (key: string) => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('ArrowLeft');
  press('ArrowLeft');
  expect(localStorage.getItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(INNER_SIDEBAR_DEFAULT_WIDTH_PX - 16));
  await expect.poll(() => width(ui.column()!)).toBe(INNER_SIDEBAR_DEFAULT_WIDTH_PX - 16);
});

it('a restart comes back at the stored width', async () => {
  localStorage.setItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY, '300');
  const ui = await renderWorkspace();
  expect(width(ui.column()!)).toBe(300);
  expect(centreX(ui.innerHandle()!)).toBeCloseTo(ui.column()!.getBoundingClientRect().right);
});

it('a narrower window or a wider list makes the column give way; the stored width comes back with the room', async () => {
  await page.viewport(1600, 700);
  localStorage.setItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY, '500');
  const ui = await renderWorkspace();
  expect(width(ui.column()!)).toBe(500);

  // 1000 wide, list 240: the card is 760, 40% of it is 304.
  await page.viewport(1000, 700);
  await expect.poll(() => width(ui.column()!)).toBe(304);
  expect(centreX(ui.innerHandle()!)).toBeCloseTo(ui.column()!.getBoundingClientRect().right);

  // The list dragged to its own cap (40% of 1000): the card is 600, 40% of it is 240.
  const listHandle = ui.handles()[0];
  const start = centreX(listHandle);
  pointer('pointerdown', listHandle, start);
  pointer('pointermove', listHandle, start + 300);
  pointer('pointerup', listHandle, start + 300);
  await expect.poll(() => width(ui.list())).toBe(400);
  await expect.poll(() => width(ui.column()!)).toBe(240);
  expect(width(ui.surface())).toBeGreaterThan(300);

  expect(localStorage.getItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY), 'the choice itself is kept').toBe('500');
  // 1700 wide, list 400: the card is 1300, 40% of it is over 500 again.
  await page.viewport(1700, 700);
  await expect.poll(() => width(ui.column()!)).toBe(500);
});

it('a narrow window never cuts the column below today\'s width', async () => {
  await page.viewport(800, 700);
  const ui = await renderWorkspace();
  // 800 wide, list 240: 40% of the 560 card is 224, under today's 240 — the column keeps 240.
  expect(width(ui.column()!)).toBe(INNER_SIDEBAR_DEFAULT_WIDTH_PX);
});

it('the drag guard sits over the tab strip behind the content, so pressing there resizes instead of dragging the window', async () => {
  const ui = await renderWorkspace();
  const handle = ui.innerHandle()!;
  const guard = ui.guards()[1];
  expect(ui.guards()).toHaveLength(2);
  expect(guard.getBoundingClientRect().toJSON()).toEqual(handle.getBoundingClientRect().toJSON());
  expect(getComputedStyle(guard).getPropertyValue('-webkit-app-region')).toBe('no-drag');
  expect(getComputedStyle(guard).pointerEvents, 'the pointer still lands on the handle').toBe('none');
  // Drag regions stack in document order: the guard must come after the content (whose tab strip is a window drag band).
  expect(ui.surface().compareDocumentPosition(guard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const strip = harness.container.querySelector<HTMLElement>('.session-tab-bar')!;
  expect(getComputedStyle(strip).getPropertyValue('-webkit-app-region'), 'the strip is a drag band: without the guard it would win').toBe('drag');
  const box = guard.getBoundingClientRect();
  const band = strip.getBoundingClientRect();
  expect(band.left, 'the strip reaches under the handle\'s right half').toBeLessThan(box.right);
  expect(band.left).toBeGreaterThanOrEqual(box.left);
  // The handle stays before the column in document order: the card's two halves are adjacent siblings (desktop-shell.css).
  expect(ui.column()!.nextElementSibling).toBe(ui.surface());
});

it('folding the column takes its handle and guard away; unfolding brings them back at the same width', async () => {
  localStorage.setItem(INNER_SIDEBAR_WIDTH_STORAGE_KEY, '320');
  const ui = await renderWorkspace();
  expect(ui.handles()).toHaveLength(2);
  await act(async () => runInAction(() => columnShown.set(false)));
  expect(ui.handles()).toHaveLength(1);
  expect(ui.guards()).toHaveLength(1);
  await act(async () => runInAction(() => columnShown.set(true)));
  await expect.poll(() => ui.handles().length).toBe(2);
  expect(width(ui.column()!)).toBe(320);
});
