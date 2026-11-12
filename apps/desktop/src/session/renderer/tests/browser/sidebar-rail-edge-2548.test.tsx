// GUYI-AI/gugu#2548: the one-list sidebar collapsed to its rail, inside the desktop shell's light workspace (#7610 C, the
// owner's window): the rail is painted over its whole occupied width in one colour, the reading surface starts right at
// its edge, and that edge is the same one the expanded sidebar has.
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { LeftSidebar } from '@renderer/features/sidebar/left-sidebar';
import { WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';
import { WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

// Real layout layers and stylesheets; data, services and the list's rows (drawn by the shell) replaced.
vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/sessions/stores/session-agent-bindings', () => ({ sessionAgentBindings: { start: () => {}, bindingFor: () => undefined } }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { start: () => {} } }));
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => null }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: (key: string) => ({ value: key === 'interface' ? { sidebarIntro: 'ended' } : {} }) }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: () => {} }), useWorkspaceSlots: () => ({ currentView: 'session-history' }), isCurrentView: (current: string, view: string) => current === view, useParams: () => ({ params: {}, setParams: () => {} }) }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { history: { canGoBack: false }, projects: { projects: new Map(), ensureMounted: vi.fn() }, navigation: { currentViewId: 'session-history', viewParamsStore: {}, revalidate: () => {} } }, sidebarStore: { sidebarProjects: [], joinedGroups: [], setStateGroupsEnabled: () => {}, setAssistantAgentId: () => {}, setAssistantHomeProjectId: () => {}, setAgentNameOnHoverEnabled: () => {} } }));
vi.mock('@renderer/features/sidebar/session-keyboard-nav', () => ({ sessionKeyboardNav: { cursor: null, syncCursorFromPointer: () => {} } }));
vi.mock('@renderer/features/sidebar/use-sidebar-drop', () => ({ useSidebarDrop: () => ({ isDragOver: false }) }));
vi.mock('@renderer/features/sidebar/sidebar-one-list', () => ({ SidebarOneList: () => null }));
vi.mock('@renderer/features/sidebar/sidebar-one-list-empty', () => ({ SidebarOneListEmpty: () => null }));
vi.mock('@renderer/features/sidebar/inner-sidebar', async () => {
  const { observable } = await import('mobx');
  return { innerSidebarChat: observable.box(null, { deep: false }), innerSidebarShownFor: observable.box(null) };
});
vi.mock('@renderer/features/sidebar/sidebar-search-trigger', () => ({ SidebarSearchTrigger: () => null }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', () => ({ ShellSidebarToggle: () => null }));
vi.mock('@renderer/lib/components/nav-buttons', () => ({ navigateBack: () => {} }));
vi.mock('@/hooks/useNativeConversationChat', () => ({ useNativeConversationChat: () => null }));

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => {
  harness?.cleanup();
  delete document.documentElement.dataset.windowMaterial;
  delete document.documentElement.dataset.theme;
});

/** The colour on screen at a point: the first non-transparent background from the topmost element up. */
function paintedAt(x: number, y: number): string {
  for (let element: Element | null = document.elementFromPoint(x, y); element; element = element.parentElement) {
    const color = getComputedStyle(element).backgroundColor;
    if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
  }
  return 'none';
}

const surfaceEdge = (surface: HTMLElement) => {
  const style = getComputedStyle(surface);
  return { radius: style.borderTopLeftRadius, shadow: style.boxShadow, margin: style.marginLeft, border: style.borderLeftWidth };
};

for (const material of ['native', 'opaque'] as const) {
  it(`collapsed, the rail is one colour over its whole width and meets the surface with the expanded edge (${material})`, async () => {
    await page.viewport(1000, 700);
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.windowMaterial = material;
    harness = createReactHarness();
    // MainLayout's desktop shell: the far-left rail, then the workspace that paints --shell-bg (layouts/MainLayout.tsx).
    await harness.render(
      <div data-desktop-shell="" data-gugu-shell-phase="active" style={{ display: 'flex', width: '100vw', height: '100vh', background: 'var(--shell-bg)' }}>
        <aside className="gg-sidebar-rail" />
        <div style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden', display: 'flex', borderRadius: 'var(--radius-page)', background: 'var(--shell-bg)' }}>
          <div className="gg-session-frame">
            <div className="gg-session-frame-host">
              <div className="gugu-skin emlight" style={{ height: '100%' }}>
                <SessionLocalizationProvider>
                  <WorkspaceLayoutContextProvider>
                    <WorkspaceLayout leftSidebar={<LeftSidebar />} mainContent={<div className="h-full bg-background">history</div>} />
                  </WorkspaceLayoutContextProvider>
                </SessionLocalizationProvider>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
    const aside = document.querySelector<HTMLElement>('[data-workspace-left-panel]')!;
    const surface = document.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
    const expandedEdge = surfaceEdge(surface);

    document.querySelector<HTMLElement>('[data-testid="sidebar-fold"]')!.click();
    await expect.poll(() => aside.getBoundingClientRect().width, { timeout: 3000 }).toBe(72);

    const rail = aside.getBoundingClientRect();
    for (const layer of [aside.firstElementChild!, document.querySelector('[data-region="left-sidebar"]')!]) {
      const box = layer.getBoundingClientRect();
      expect([box.left, box.width]).toEqual([rail.left, rail.width]);
    }
    expect(surface.getBoundingClientRect().left).toBe(rail.right);
    const y = rail.top + rail.height / 2;
    // The rail's own colour from its left edge to the last pixel before the surface: no band of another colour.
    const railColor = paintedAt(rail.left + 4, y);
    for (const x of [rail.left + 36, rail.right - 12, rail.right - 3]) expect(paintedAt(x, y)).toBe(railColor);
    expect(surfaceEdge(surface)).toEqual(expandedEdge);
  });
}
