import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { ListColumnToggle } from '@/components/PanelToggleButtons';
import { publishPanelToggle } from '@/lib/panelToggles';
import { ShellRestoreLane } from '@renderer/lib/components/titlebar/shell-restore-lane';
import { WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';
import { WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { CONVERSATION_CAPSULE_CLASS, CONVERSATION_CAPSULE_LAYER_CLASS } from '@renderer/features/tabs/tab-bar/conversation-capsule';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';
import { writeInterface } from '@/lib/viewStateTable';

/**
 * A conversation's header moves the window from its blank, and its controls stay clickable. Real Chromium, real CSS:
 * the region at a point is what Electron makes of it — every box with a drag or no-drag region adds or cuts its rectangle
 * in document order, so the last such box over the point decides. With the inner column
 * folded this header was the only band of the window left, and its capsule's layer (over the whole strip) computed
 * `no-drag`: nothing moved the window.
 */

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', async (original) => ({ ...(await original<object>()), ShellSidebarToggle: () => null }));

let harness: ReturnType<typeof createReactHarness>;
let unpublish: () => void = () => {};
beforeEach(async () => {
  await page.viewport(1100, 700);
  writeInterface('gugu.taskpage.sidebarWidth', undefined);
  document.documentElement.dataset.platform = 'mac';
});
afterEach(() => {
  harness?.cleanup();
  unpublish();
  delete document.documentElement.dataset.platform;
});

/** Electron's Chromium inherits the region (a box that sets none computes its parent's); the test's Chromium does not. */
function regionOf(element: Element | null): string {
  if (!element) return 'none';
  const value = getComputedStyle(element).getPropertyValue('-webkit-app-region');
  return value === 'drag' || value === 'no-drag' ? value : regionOf(element.parentElement);
}
function regionAt(x: number, y: number): string {
  let region = 'none';
  for (const element of document.querySelectorAll('*')) {
    const value = regionOf(element);
    if (value === 'none') continue;
    const r = element.getBoundingClientRect();
    if (r.width && r.height && x >= r.left && x < r.right && y >= r.top && y < r.bottom) region = value;
  }
  return region;
}
const centre = (selector: string) => {
  const r = document.querySelector(selector)!.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2] as const;
};

async function renderHeader(columnFolded: boolean) {
  if (columnFolded) unpublish = publishPanelToggle('column:inner', { open: false, label: '展开内层栏', toggle: () => {} });
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
        <WorkspaceLayout
          leftSidebar={<div>one list</div>}
          innerSidebarRestore={columnFolded ? <ShellRestoreLane><ListColumnToggle slot="column:inner" /></ShellRestoreLane> : null}
          mainContent={
            <TabStripShell reserveShellRestoreLane={columnFolded}
              leadingSlot={columnFolded ? undefined : <button type="button" data-probe="grip" style={{ width: 20, height: 28 }} />}
              actionsSlot={<button type="button" data-probe="action" style={{ width: 28, height: 28 }} />}>
              <div className={CONVERSATION_CAPSULE_LAYER_CLASS}>
                <div className={`${CONVERSATION_CAPSULE_CLASS} pointer-events-auto`} data-probe="capsule">产品讨论群</div>
              </div>
            </TabStripShell>
          }
        />
      </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
    </div>
  );
  const strip = document.querySelector('.session-tab-bar')!.getBoundingClientRect();
  const capsule = document.querySelector('[data-probe="capsule"]')!.getBoundingClientRect();
  const y = strip.top + strip.height / 2;
  for (const x of [strip.left + strip.width * 0.3, capsule.left - 20, capsule.right + 20, strip.left + strip.width * 0.8]) {
    expect(regionAt(x, y), `header blank at x=${Math.round(x)}`).toBe('drag');
  }
  for (const probe of ['[data-probe="capsule"]', '[data-probe="action"]']) expect(regionAt(...centre(probe)), probe).toBe('no-drag');
}

it('inner column folded: the header blank drags the window; the capsule, the buttons and the column toggle do not', async () => {
  await renderHeader(true);
  expect(regionAt(...centre('[data-shell-restore-lane] button'))).toBe('no-drag');
});

it('split: the block handle at the strip start keeps its hole under the capsule layer', async () => {
  await renderHeader(false);
  expect(regionAt(...centre('[data-probe="grip"]'))).toBe('no-drag');
});
