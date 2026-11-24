import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { SIDEBAR_DEFAULT_WIDTH_PX } from '@renderer/lib/layout/layout-provider';
import { WorkspaceLayout, WorkspaceContentLayout } from '@renderer/lib/layout/workspace-layout';
import { SIDEBAR_RAIL_PX, WorkspaceLayoutContextProvider, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { sidebarFolds } from '@renderer/features/sidebar/sidebar-folds';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';
import { readInterface, writeInterface } from '@/lib/viewStateTable'

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
// The shell toggle publishes host IPC; this case exercises the actual layout/context instead.
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', async (original) => ({ ...(await original<object>()), ShellSidebarToggle: () => null }));

let harness: ReturnType<typeof createReactHarness>;
const mounted = vi.fn();
function Body() {
  useEffect(() => { mounted(); }, []);
  const { toggleLeft } = useWorkspaceLayoutContext();
  return <><input aria-label="retained draft" defaultValue="keep this draft" /><button onClick={toggleLeft}>toggle list</button></>;
}
beforeEach(async () => {
  await page.viewport(1000, 700);
  writeInterface('gugu.taskpage.sidebarWidth', undefined);
  document.documentElement.dataset.platform = 'mac';
  document.documentElement.dataset.theme = 'light';
  document.documentElement.dataset.windowMaterial = 'native';
  mounted.mockClear();
});
afterEach(() => {
  harness?.cleanup();
  sidebarFolds.clear(); // a fold is stored state: it must not be the next test's start
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.windowMaterial;
});

it('the real workspace keeps an opaque rounded reading surface inset from material, with local chrome retained through collapse', async () => {
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
        <WorkspaceLayout
          leftSidebar={<div>project list</div>}
          mainContent={<WorkspaceContentLayout
            titlebarSlot={<ShellTitlebar leftSlot={<button aria-label="project menu" style={{ height: 28 }}>project</button>} />}
            mainPanel={<Body />}
          />}
        />
      </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
    </div>
  );
  const shell = harness.container.querySelector<HTMLElement>('[data-workspace-shell]')!;
  const surface = harness.container.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
  expect(shell).not.toBeNull();
  expect(shell.querySelector<HTMLElement>('[data-workspace-left-panel]')!.getBoundingClientRect().width).toBe(SIDEBAR_DEFAULT_WIDTH_PX); // 第 16 版:列表默认 236(layout-provider)
  expect(surface).not.toBeNull();
  const rect = surface.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(700);
  expect(rect.top - shell.getBoundingClientRect().top).toBeCloseTo(5);
  expect(shell.getBoundingClientRect().right - rect.right).toBeCloseTo(5);
  expect(shell.getBoundingClientRect().bottom - rect.bottom).toBeCloseTo(5);
  const style = getComputedStyle(surface);
  expect(style.borderRadius).toBe('12px');
  expect(style.backgroundColor).toBe('rgb(255, 255, 255)');
  expect(style.boxShadow).not.toBe('none');
  expect(shell.querySelector('[data-workspace-left-panel] > .bg-border'), 'no full-height line may protrude into the rounded frame gutter').toBeNull();
  const local = harness.container.querySelector<HTMLElement>('[aria-label="project menu"]')!;
  const center = (element: HTMLElement) => { const box = element.getBoundingClientRect(); return box.top + box.height / 2; };
  const localCenter = center(local);
  const draft = harness.container.querySelector<HTMLInputElement>('[aria-label="retained draft"]')!;
  await userEvent.click([...harness.container.querySelectorAll('button')].find((button) => button.textContent === 'toggle list')!);
  await until('the real list collapses to its rail', () => shell.querySelector<HTMLElement>('[data-workspace-left-panel]')!.getBoundingClientRect().width === SIDEBAR_RAIL_PX);
  expect(harness.container.querySelector('[aria-label="retained draft"]')).toBe(draft);
  expect(draft.value).toBe('keep this draft');
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(surface.getBoundingClientRect().top - shell.getBoundingClientRect().top).toBeCloseTo(5);
  expect(center(local)).toBeCloseTo(localCenter);
});

it('a saved user sidebar width takes precedence over the unified navigation default', async () => {
  writeInterface('gugu.taskpage.sidebarWidth', 320);
  harness = createReactHarness();
  await harness.render(<div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
    <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
      <WorkspaceLayout leftSidebar={<div>project list</div>} mainContent={<div>content</div>} />
    </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
  </div>);
  const aside = harness.container.querySelector<HTMLElement>('[data-workspace-left-panel]')!;
  expect(aside.getBoundingClientRect().width).toBe(320);
  expect(readInterface('gugu.taskpage.sidebarWidth')).toBe(320);
  writeInterface('gugu.taskpage.sidebarWidth', undefined);
});
