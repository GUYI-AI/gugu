import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { ListColumnToggle } from '@/components/PanelToggleButtons';
import { publishPanelToggle } from '@/lib/panelToggles';
import { ShellRestoreLane } from '@renderer/lib/components/titlebar/shell-restore-lane';
import { WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';
import { WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

/**
 * GUYI-AI/gugu#2548 ⑤ the inner column folded: its expand button floats at the content card's top-left, in the restore
 * lane (the list column toggle on the sidebar toggle's baseline), and the leftmost tab strip leaves it that lane — the
 * button sits left of the chat's own tab, centred in the strip, overlapping nothing (proposal v1 state1).
 */

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', async (original) => ({ ...(await original<object>()), ShellSidebarToggle: () => null }));

let harness: ReturnType<typeof createReactHarness>;
let unpublish: () => void = () => {};
beforeEach(async () => {
  await page.viewport(1100, 700);
  localStorage.removeItem('gugu.taskpage.sidebarWidth');
  document.documentElement.dataset.platform = 'mac';
  document.documentElement.dataset.theme = 'light';
});
afterEach(() => {
  harness?.cleanup();
  unpublish();
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.theme;
});

it('the expand button sits in the restore lane, left of the first tab and centred in the strip', async () => {
  const toggle = vi.fn();
  unpublish = publishPanelToggle('column:inner', { open: false, label: '展开内层栏', toggle });
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
        <WorkspaceLayout
          leftSidebar={<div>one list</div>}
          innerSidebarRestore={<ShellRestoreLane><ListColumnToggle slot="column:inner" /></ShellRestoreLane>}
          mainContent={
            <TabStripShell reserveShellRestoreLane>
              <TabSlot data-first-tab=""><TabChip isActive isFocusedPane label="产品讨论群" /></TabSlot>
            </TabStripShell>
          }
        />
      </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
    </div>
  );
  const surface = harness.container.querySelector<HTMLElement>('[data-workspace-content-surface]')!.getBoundingClientRect();
  const strip = harness.container.querySelector<HTMLElement>('.session-tab-bar')!.getBoundingClientRect();
  const button = harness.container.querySelector<HTMLElement>('[data-shell-restore-lane] button')!;
  const box = button.getBoundingClientRect();
  const tab = harness.container.querySelector<HTMLElement>('[data-first-tab]')!.getBoundingClientRect();
  expect(surface.width, 'real CSS geometry must be present').toBeGreaterThan(600);
  expect(button.getAttribute('aria-label')).toBe('展开内层栏');
  expect(button.textContent, 'no number on it').toBe('');
  expect(box.left - surface.left).toBeCloseTo(8);
  expect(box.width).toBeCloseTo(28);
  expect(box.top + box.height / 2).toBeCloseTo(strip.top + strip.height / 2);
  expect(tab.left, 'the strip leaves the button its lane').toBeGreaterThanOrEqual(box.right);
  // Real hit testing: the button, not the strip under it, takes the click.
  expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('button')).toBe(button);
  button.click();
  expect(toggle).toHaveBeenCalledTimes(1);
});
