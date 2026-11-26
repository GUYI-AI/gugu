import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { WorkspaceLayout, WorkspaceContentLayout } from '@renderer/lib/layout/workspace-layout';
import { useInnerSidebarFrame, WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { InnerModuleStack } from '@renderer/features/sidebar/inner-sidebar-parts';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

/**
 * GUYI-AI/gugu#2548 叠一层(owner 11-12): beside the one list, the content is a card stacked on the list — the same
 * layering as the icon rail and the list. Direction A (owner 11-26, GUYI-AI/gugu-dev#1515, desktop-shell.css
 * @@@inner-on-card): a group's / project's inner column is the left part of that card — the card's face, its top and bottom
 * gap and left corners — and no line runs between it and the content; its modules float as one panel inside the card,
 * filling the column down to the card's bottom gap (inner-sidebar-head.css @@@inner-modules); folded, the content surface is
 * the whole card again.
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

/** The inner column as InnerSidebarFrame draws it: filling the slot the layout sizes (today's width, 240). */
function InnerColumn({ folded = false, open = null }: { folded?: boolean; open?: string | null }) {
  useInnerSidebarFrame(folded);
  return (
    <div data-region="inner-sidebar" className="relative flex h-full w-full flex-col">
      <div data-test-head="" style={{ height: 79 }} />
      <InnerModuleStack open={open} modules={[
        { id: 'topics', node: <div data-inner-sidebar-section="topics" style={{ height: 120 }} /> },
        { id: 'agents', node: <div data-inner-sidebar-section="agents" style={{ height: 60 }} /> },
      ]} />
    </div>
  );
}

/** Which sides a ring of 0.5px offset shadows draws (x/y offsets of each shadow, read from the computed value). */
function ringSides(shadow: string): string[] {
  return [...shadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px [\d.]+px [\d.]+px/g)].map(([, x, y]) =>
    Number(x) < 0 ? 'left' : Number(x) > 0 ? 'right' : Number(y) < 0 ? 'top' : 'bottom');
}

async function renderDesktop(theme: 'light' | 'dark', inner: boolean, folded = false, open: string | null = null) {
  document.documentElement.dataset.theme = theme;
  // 界面减法 #10: the list is the window's leftmost column and lies on the window's ground like the old rail did; both
  // themes run with the desktop window's marker like the real main window.
  document.documentElement.dataset.windowMaterial = 'opaque';
  harness = createReactHarness();
  await harness.render(<div data-desktop-shell="" style={{ position: 'fixed', inset: 0, display: 'flex' }}>
    <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
      <div className="gg-session-frame" style={{ flex: 1 }}><div className="gg-session-frame-host">
        <div className={`gugu-skin ${theme === 'light' ? 'emlight' : 'emdark'}`} style={{ height: '100%', width: '100%' }}>
          <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
            <WorkspaceLayout
              leftSidebar={<div>one list</div>}
              innerSidebar={inner ? <InnerColumn folded={folded} open={open} /> : null}
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

  it(`${theme}: the inner column is the left part of the card: its face, its gap, its left corners, no line to the content`, async () => {
    const { shell, list, surface, column } = await renderDesktop(theme, true);
    expect(column).not.toBeNull();
    const left = column!.getBoundingClientRect();
    const right = surface.getBoundingClientRect();
    const col = getComputedStyle(column!);
    const card = getComputedStyle(surface);
    expect(left.left).toBeCloseTo(list.right);
    expect(right.left).toBeCloseTo(left.right);
    expect(left.top, 'the column starts where the card starts').toBeCloseTo(right.top);
    expect(left.bottom).toBeCloseTo(right.bottom);
    // Beside the column the card keeps the conversation's 8px gap everywhere (the layout marks it data-inner-column).
    expect(surface.hasAttribute('data-inner-column')).toBe(true);
    expect(right.top - shell.top).toBeCloseTo(8);
    expect(shell.right - right.right).toBeCloseTo(8);
    expect(shell.bottom - right.bottom).toBeCloseTo(8);
    expect(col.backgroundColor, 'one face').toBe(card.backgroundColor);
    expect(col.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect([col.borderTopLeftRadius, col.borderBottomLeftRadius, col.borderTopRightRadius, col.borderBottomRightRadius]).toEqual(['12px', '12px', '0px', '0px']);
    expect([card.borderTopLeftRadius, card.borderBottomLeftRadius, card.borderTopRightRadius, card.borderBottomRightRadius]).toEqual(['0px', '0px', '12px', '12px']);
    // The ring: the column draws the card's left side, the content the rest; neither draws the line between them.
    expect(ringSides(col.boxShadow)).toEqual(['left', 'top', 'bottom']);
    expect(ringSides(card.boxShadow)).toEqual(['top', 'right', 'bottom']);
    expect(col.borderLeftWidth).toBe('0px');
  });

  it(`${theme}: the modules float as one panel inside the card: the lift, the surface radius, a gap, down to the card's bottom gap`, async () => {
    const { surface, column } = await renderDesktop(theme, true);
    const stack = column!.querySelector<HTMLElement>('[data-inner-module-stack]')!;
    const style = getComputedStyle(stack);
    // The product's one lift and surface radius, resolved in this theme (no new elevation or colour).
    const probe = document.createElement('div');
    probe.style.boxShadow = 'var(--shadow-lift)';
    stack.parentElement!.append(probe);
    expect(style.boxShadow).toBe(getComputedStyle(probe).boxShadow);
    probe.remove();
    expect(style.boxShadow).not.toBe('none');
    expect(style.borderRadius).toBe('12px');
    expect(style.backgroundColor, 'the card face, not a third colour').toBe(getComputedStyle(surface).backgroundColor);
    const box = stack.getBoundingClientRect();
    const col = column!.getBoundingClientRect();
    expect(box.left - col.left).toBeCloseTo(8);
    expect(col.right - box.right).toBeCloseTo(8);
    // V2 (owner 11-26): the panel fills the column under the head, its bottom --spacing-sm above the card's bottom edge — the
    // composer's bottom line — so no L of empty space is left under it.
    const head = column!.querySelector<HTMLElement>('[data-test-head]')!.getBoundingClientRect();
    expect(box.top - head.bottom, 'right under the head').toBeCloseTo(0);
    expect(col.bottom - box.bottom, 'the card\'s bottom gap').toBeCloseTo(8);
    expect([...stack.querySelectorAll('[data-inner-sidebar-section]')].map((e) => e.getAttribute('data-inner-sidebar-section'))).toEqual(['topics', 'agents']);
  });

  it(`${theme}: one module opened in place takes the panel; the others step aside`, async () => {
    const { column } = await renderDesktop(theme, true, false, 'topics');
    const stack = column!.querySelector<HTMLElement>('[data-inner-module-stack]')!;
    expect([...stack.querySelectorAll('[data-inner-sidebar-section]')].map((e) => e.getAttribute('data-inner-sidebar-section'))).toEqual(['topics']);
  });

  it(`${theme}: folded, the content surface is the whole card again`, async () => {
    const { surface } = await renderDesktop(theme, true, true);
    const card = getComputedStyle(surface);
    expect(card.borderRadius).toBe('12px');
    expect(card.boxShadow).toMatch(/0px 0px 0px 0\.5px/);
  });

  it(`${theme}: the list lies on the window's material (no outer frame), ❌ a veil of its own; the column is on the card`, async () => {
    const { column, surface } = await renderDesktop(theme, true);
    const frame = harness.container.querySelector<HTMLElement>('[data-desktop-shell] > div')!;
    const list = harness.container.querySelector<HTMLElement>('[data-workspace-left-panel]')!;
    expect(getComputedStyle(frame).marginTop).toBe('0px');
    expect(getComputedStyle(list).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(column!).backgroundColor).toBe(getComputedStyle(surface).backgroundColor);
  });
}
