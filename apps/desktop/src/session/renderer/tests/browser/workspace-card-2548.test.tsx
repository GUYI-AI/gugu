import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { WorkspaceLayout, WorkspaceContentLayout } from '@renderer/lib/layout/workspace-layout';
import { WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

/**
 * GUYI-AI/gugu#2548 叠一层(owner 11-12): beside the one list, the content is a card stacked on the list — the same
 * layering as the icon rail and the list. A group's / project's inner column belongs to the list layer (full height, no
 * card of its own), so the content surface alone is the card — the same shape as the task page.
 */

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', async (original) => ({ ...(await original<object>()), ShellSidebarToggle: () => null }));

let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await page.viewport(1100, 700);
  localStorage.removeItem('gugu.taskpage.sidebarWidth');
  document.documentElement.dataset.platform = 'mac';
});
afterEach(() => {
  harness?.cleanup();
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.windowMaterial;
});

async function renderDesktop(theme: 'light' | 'dark', inner: boolean) {
  document.documentElement.dataset.theme = theme;
  // The light desktop main window flattens its reading surface into the rail's workspace frame (#7610); the card must
  // survive that rule, so the light case runs with a window material like the real main window.
  if (theme === 'light') document.documentElement.dataset.windowMaterial = 'native';
  harness = createReactHarness();
  await harness.render(<div data-desktop-shell="" style={{ position: 'fixed', inset: 0, display: 'flex' }}>
    <nav className="gg-sidebar-rail" />
    <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
      <div className="gg-session-frame" style={{ flex: 1 }}><div className="gg-session-frame-host">
        <div className={`gugu-skin ${theme === 'light' ? 'emlight' : 'emdark'}`} style={{ height: '100%', width: '100%' }}>
          <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
            <WorkspaceLayout
              leftSidebar={<div>one list</div>}
              innerSidebar={inner ? <div data-region="inner-sidebar" className="relative flex h-full shrink-0 flex-col bg-background-tertiary" style={{ width: 240 }} /> : null}
              mainContent={<WorkspaceContentLayout titlebarSlot={null} mainPanel={<div>reading surface</div>} />}
            />
          </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
        </div>
      </div></div>
    </div>
  </div>);
  const shell = harness.container.querySelector<HTMLElement>('[data-workspace-shell]')!;
  const list = harness.container.querySelector<HTMLElement>('[data-workspace-left-panel]')!;
  const surface = harness.container.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
  const column = harness.container.querySelector<HTMLElement>('[data-region="inner-sidebar"]');
  return { shell: shell.getBoundingClientRect(), list: list.getBoundingClientRect(), surface, column };
}

for (const theme of ['light', 'dark'] as const) {
  it(`${theme}: without an inner column the content surface alone is the card, inset and rounded at every corner`, async () => {
    const { shell, list, surface } = await renderDesktop(theme, false);
    const box = surface.getBoundingClientRect();
    expect(box.width, 'real CSS geometry must be present').toBeGreaterThan(600);
    expect(box.left).toBeCloseTo(list.right);
    expect(box.top - shell.top).toBeCloseTo(5);
    expect(shell.right - box.right).toBeCloseTo(5);
    expect(shell.bottom - box.bottom).toBeCloseTo(5);
    const style = getComputedStyle(surface);
    expect(style.borderRadius).toBe('12px');
    expect(style.boxShadow).not.toBe('none');
    expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  it(`${theme}: the inner column sits on the list layer and the content surface alone is the card`, async () => {
    const { shell, list, surface, column } = await renderDesktop(theme, true);
    expect(column).not.toBeNull();
    const left = column!.getBoundingClientRect();
    const right = surface.getBoundingClientRect();
    expect(left.left).toBeCloseTo(list.right);
    expect(left.top, 'the column runs the full height, like the list').toBeCloseTo(shell.top);
    expect(left.bottom).toBeCloseTo(shell.bottom);
    expect(getComputedStyle(column!).borderRadius).toBe('0px');
    expect(getComputedStyle(column!).boxShadow).toBe('none');
    expect(right.left).toBeCloseTo(left.right);
    expect(right.top - shell.top).toBeCloseTo(5);
    expect(shell.right - right.right).toBeCloseTo(5);
    expect(shell.bottom - right.bottom).toBeCloseTo(5);
    expect(getComputedStyle(surface).borderRadius).toBe('12px');
    expect(getComputedStyle(surface).boxShadow).not.toBe('none');
  });
}
