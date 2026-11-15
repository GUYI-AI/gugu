import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { ListColumnToggle } from '@/components/PanelToggleButtons';
import { publishPanelToggle } from '@/lib/panelToggles';
import { InnerHeadRowLayout, InnerSidebarFoldButton } from '@renderer/features/sidebar/inner-sidebar-parts';
import { ShellRestoreLane } from '@renderer/lib/components/titlebar/shell-restore-lane';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

/**
 * The inner column's head and the content's tab strip share one line: same top, same height. Folding the column swaps
 * its fold button for the restore lane's expand button —
 * the same 28px button with the same 16px icon, so a click does not make it shrink (owner 11-14).
 */

let harness: ReturnType<typeof createReactHarness>;
let unpublish: () => void = () => {};
beforeEach(async () => {
  await page.viewport(1000, 400);
  document.documentElement.dataset.platform = 'mac';
  document.documentElement.dataset.theme = 'light';
});
afterEach(() => {
  harness?.cleanup();
  unpublish();
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.theme;
});

it('the head band and the tab strip line up, and the fold button is the expand button\'s size', async () => {
  unpublish = publishPanelToggle('column:inner', { open: false, label: '展开内层栏', toggle: () => {} });
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'flex-start' }}>
      <SessionLocalizationProvider>
        <div style={{ width: 260 }} data-head-column="">
          <InnerHeadRowLayout headKey="room" name="产品讨论群" avatar={<span className="block size-6" />} active onOpen={() => {}} trailingButtons={1}>
            <InnerSidebarFoldButton />
          </InnerHeadRowLayout>
        </div>
        <div style={{ position: 'relative', flex: 1 }}>
          <TabStripShell reserveShellRestoreLane>
            <TabSlot><TabChip isActive isFocusedPane label="产品讨论群" /></TabSlot>
          </TabStripShell>
          <ShellRestoreLane><ListColumnToggle slot="column:inner" /></ShellRestoreLane>
        </div>
      </SessionLocalizationProvider>
    </div>
  );
  const box = (selector: string) => harness.container.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
  const band = harness.container.querySelector<HTMLElement>('[data-inner-head]')!.parentElement!;
  const strip = harness.container.querySelector<HTMLElement>('.session-tab-bar')!;
  expect(box('.session-tab-bar').width, 'real CSS geometry must be present').toBeGreaterThan(400);

  const head = band.getBoundingClientRect();
  expect(head.top).toBeCloseTo(strip.getBoundingClientRect().top, 1);
  expect(head.height).toBeCloseTo(strip.getBoundingClientRect().height, 1);

  const fold = box('[data-inner-head-fold]');
  const expand = box('[data-shell-restore-lane] button');
  const foldIcon = box('[data-inner-head-fold] svg');
  const expandIcon = box('[data-shell-restore-lane] svg');
  expect([fold.width, fold.height]).toEqual([expand.width, expand.height]);
  expect([foldIcon.width, foldIcon.height]).toEqual([expandIcon.width, expandIcon.height]);
  // Both centred on the band's middle line.
  expect(fold.top + fold.height / 2).toBeCloseTo(head.top + head.height / 2, 1);
  expect(expand.top + expand.height / 2).toBeCloseTo(head.top + head.height / 2, 1);
});
