import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { ListColumnToggle } from '@/components/PanelToggleButtons';
import { publishPanelToggle } from '@/lib/panelToggles';
import { TITLEBAR_ACTION_ICON_SIZE_PX } from '@/lib/window-chrome';
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
 * both controls use the same arrow-free icon and 28px target.
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
  const foldIcon = box('[data-inner-head-fold] svg.lucide-panel-left');
  const expandIcon = box('[data-shell-restore-lane] svg.lucide-panel-left');
  expect([fold.width, fold.height]).toEqual([expand.width, expand.height]);
  expect([foldIcon.width, foldIcon.height]).toEqual([TITLEBAR_ACTION_ICON_SIZE_PX, TITLEBAR_ACTION_ICON_SIZE_PX]);
  expect([expandIcon.width, expandIcon.height]).toEqual([foldIcon.width, foldIcon.height]);
  // Both centred on the band's middle line.
  expect(fold.top + fold.height / 2).toBeCloseTo(head.top + head.height / 2, 1);
  expect(expand.top + expand.height / 2).toBeCloseTo(head.top + head.height / 2, 1);
});

it('the two-line group button covers the avatar and lower row, with independent actions above it', async () => {
  harness = createReactHarness();
  const open = vi.fn();
  const create = vi.fn();
  const row = (active: boolean) => (
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider>
        {/* The column's content box (v16: 220 wide less its 1px border to the zero list). */}
        <div data-region="inner-sidebar" style={{ width: 219 }}>
          <InnerHeadRowLayout headKey="group" name="产品讨论群" active={active} onOpen={open} trailingButtons={1}
            avatar={<span data-proof-avatar="" className="block size-10" />}
            createAction={{ label: '创建智能体', onClick: create }}
          >
            <InnerSidebarFoldButton />
          </InnerHeadRowLayout>
        </div>
      </SessionLocalizationProvider>
    </div>
  );
  await harness.render(row(false));
  const button = () => harness.container.querySelector<HTMLElement>('[data-inner-head-open]')!;
  const group = button().getBoundingClientRect();
  const avatar = harness.container.querySelector('[data-proof-avatar]')!.getBoundingClientRect();
  // v16 design: the block is 173 × 58, radius 12, its 40px avatar 6 in and 9 down; the collapse button sits outside it.
  expect([group.width, group.height, getComputedStyle(button()).borderRadius]).toEqual([173, 58, '12px']);
  expect([avatar.left - group.left, avatar.top - group.top, avatar.width, avatar.height]).toEqual([6, 9, 40, 40]);
  const fold = harness.container.querySelector<HTMLElement>('[data-inner-head-fold]')!;
  const icon = fold.querySelector('svg.lucide-panel-left')!;
  expect([fold.offsetWidth, fold.offsetHeight, getComputedStyle(fold).borderRadius]).toEqual([28, 28, '8px']);
  expect(icon.getBoundingClientRect().width).toBe(TITLEBAR_ACTION_ICON_SIZE_PX);

  const hoverLayer = () => getComputedStyle(button().parentElement!, '::before');
  const openButton = page.getByRole('button', { name: '产品讨论群', exact: true });
  const bottomOfAvatar = { x: 20, y: 42 };
  await openButton.hover({ position: bottomOfAvatar });
  expect(getComputedStyle(button()).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(hoverLayer().backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  // The hover covers the block only, not the collapse button 4px to its right.
  expect([hoverLayer().left, hoverLayer().right, hoverLayer().borderRadius]).toEqual(['0px', '32px', '12px']);
  await openButton.click({ position: bottomOfAvatar });
  expect(open).toHaveBeenCalledOnce();

  const createButton = page.getByRole('button', { name: '创建智能体', exact: true });
  const createBox = harness.container.querySelector('[data-inner-head-create]')!.getBoundingClientRect();
  expect([createBox.left - group.left, createBox.top - group.top, createBox.height]).toEqual([52, 30, 22]);
  await createButton.click();
  expect(create).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledOnce();

  await page.elementLocator(harness.container.firstElementChild!).hover({ position: { x: 450, y: 100 } });
  await harness.render(row(true));
  expect(button()).toHaveAttribute('aria-current', 'page');
  // Direction A (GUYI-AI/gugu-dev#1515): the head is the group's title on the group's card, so the open group's block wears
  // no selected fill; it stays marked as the current page.
  expect(getComputedStyle(button()).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  // Keyboard focus keeps the same hover surface on the selected block.
  expect(hoverLayer().content).toBe('""');
  expect([hoverLayer().left, hoverLayer().right, hoverLayer().borderRadius]).toEqual(['0px', '32px', '12px']);
});
