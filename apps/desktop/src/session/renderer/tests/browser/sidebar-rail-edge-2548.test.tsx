// GUYI-AI/gugu#2548: the one-list sidebar collapsed to its rail, inside the desktop shell's light workspace (#7610 C, the
// owner's window): the rail is painted over its whole occupied width in one colour, the reading surface starts right at
// its edge, and that edge is the same one the expanded sidebar has. The head's 「«」 / 「»」 sits on the avatars' axis in
// the top band, clear of the macOS traffic lights, in both states; the list runs to the window's bottom edge (no foot).
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { LeftSidebar } from '@renderer/features/sidebar/left-sidebar';
import { WorkspaceLayout } from '@renderer/lib/layout/workspace-layout';
import { WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';
import { sidebarFolds } from '@renderer/features/sidebar/sidebar-folds';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@/components/Sidebar.css';
import '@renderer/index.css';

// Real layout layers and stylesheets; data, services and the list's rows (drawn by the shell) replaced.
vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/sessions/stores/session-agent-bindings', () => ({ sessionAgentBindings: { start: () => {}, bindingFor: () => undefined } }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { start: () => {} } }));
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => null }));
vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: (key: string) => fakeAppSettings(key === 'interface' ? { sidebarIntro: 'ended' } : {}) } });
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: () => {} }), useWorkspaceSlots: () => ({ currentView: 'session-history' }), isCurrentView: (current: string, view: string) => current === view, useParams: () => ({ params: {}, setParams: () => {} }) }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { history: { canGoBack: false }, projects: { projects: new Map(), ensureMounted: vi.fn() }, navigation: { currentViewId: 'session-history', viewParamsStore: {}, revalidate: () => {} } }, sidebarStore: { sidebarProjects: [], joinedGroups: [], setAssistantAgentId: () => {}, setAssistantHomeProjectId: () => {}, setAgentNameOnHoverEnabled: () => {} } }));
vi.mock('@renderer/features/sidebar/session-keyboard-nav', () => ({ sessionKeyboardNav: { cursor: null, syncCursorFromPointer: () => {} } }));
vi.mock('@renderer/features/sidebar/use-sidebar-drop', () => ({ useSidebarDrop: () => ({ isDragOver: false }) }));
vi.mock('@renderer/features/sidebar/sidebar-one-list', () => ({ SidebarOneList: () => null }));
vi.mock('@renderer/features/sidebar/sidebar-one-list-empty', () => ({ SidebarOneListEmpty: () => null }));
vi.mock('@renderer/features/sidebar/inner-sidebar', async () => {
  const { observable } = await import('mobx');
  return { innerSidebarChat: observable.box(null, { deep: false }), innerSidebarShownFor: observable.box(null) };
});
vi.mock('@renderer/features/global-search/search-session', () => ({ openGlobalSearch: () => {} }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', () => ({ ShellSidebarToggle: () => null }));
vi.mock('@renderer/lib/components/nav-buttons', () => ({ navigateBack: () => {} }));
vi.mock('@/hooks/useNativeConversationChat', () => ({ useNativeConversationChat: () => null }));

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => {
  harness?.cleanup();
  sidebarFolds.clear(); // a fold is stored state: it must not be the next test's start
  delete document.documentElement.dataset.windowMaterial;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.platform;
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
    // The macOS window: its traffic lights sit at the top-left, over the icon rail (tokens.css, --sidebar-rail-width).
    document.documentElement.dataset.platform = 'mac';
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
    const fold = document.querySelector<HTMLElement>('[data-testid="sidebar-fold"]')!;
    const scheduled = document.querySelector<HTMLElement>('[data-testid="sidebar-scheduled"]')!;
    const history = document.querySelector<HTMLElement>('[data-testid="sidebar-session-history"]')!;
    const search = document.querySelector<HTMLElement>('[data-testid="sidebar-search-trigger"]')!;
    const lights = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-traffic-lights-width'));
    expect(lights, 'the mac tokens must be present').toBeGreaterThan(0);
    // 「«」 in the top band, centred on the avatars' axis (x = 36), right of the icon rail and the traffic lights over it.
    // The band starts one surface inset down, so it is on one line with the card's own top band (proposal v1: the list's
    // top row, the inner column's head and the content's head share a line).
    const head = (state: string) => {
      const box = fold.getBoundingClientRect();
      const panel = aside.getBoundingClientRect();
      const inset = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--desktop-surface-inset'));
      expect(inset, 'the desktop shell tokens must be present').toBeGreaterThan(0);
      expect(box.left + box.width / 2 - panel.left, state).toBe(36);
      expect(box.top + box.height / 2 - panel.top, state).toBeCloseTo(inset + 20);
      expect(box.left, state).toBeGreaterThanOrEqual(document.querySelector('.gg-sidebar-rail')!.getBoundingClientRect().right);
      expect(box.left, state).toBeGreaterThan(lights);
    };
    head('expanded');
    expect(scheduled.getBoundingClientRect().left - search.getBoundingClientRect().right).toBe(4);
    expect(history.getBoundingClientRect().left - scheduled.getBoundingClientRect().right).toBe(4);
    expect(Math.round(history.getBoundingClientRect().right)).toBe(Math.round(aside.getBoundingClientRect().right) - 12);
    expect(document.querySelector('[data-sidebar-foot]')).toBeNull();
    expect(document.querySelector('[data-region="sidebar-scroll"]')!.getBoundingClientRect().bottom).toBe(aside.getBoundingClientRect().bottom);

    fold.click();
    await expect.poll(() => aside.getBoundingClientRect().width, { timeout: 3000 }).toBe(72);
    head('collapsed');
    // The rail keeps 「»」 and 「+」. The other controls fade with the names.
    expect(fold.closest('[inert]')).toBeNull();
    for (const hidden of [scheduled, history, search, document.querySelector('[data-notification-slot="toggle"]')!]) {
      expect(hidden.closest('[inert]')).not.toBeNull();
      expect(Number(getComputedStyle(hidden.closest('[inert]')!).opacity)).toBe(0);
    }

    const rail = aside.getBoundingClientRect();
    for (const layer of [aside.closest('[data-panel-slot]')!, document.querySelector('[data-region="left-sidebar"]')!]) {
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

// A fold moves the names, the head's buttons and the top row each frame. A custom property written for that on the sidebar's
// layer is inherited by every element under it, so the whole list restyled each frame (~37k elements with the rows mounted),
// read or not. Each moving element gets its own style instead, and the names fade as one mask on the scroll box.
it('a fold writes no custom property and swaps no class: the names fade as one mask on the scroll box', async () => {
  await page.viewport(1000, 700);
  harness = createReactHarness();
  await harness.render(
    <SessionLocalizationProvider>
      <WorkspaceLayoutContextProvider>
        <WorkspaceLayout leftSidebar={<LeftSidebar />} mainContent={<div className="h-full">history</div>} />
      </WorkspaceLayoutContextProvider>
    </SessionLocalizationProvider>
  );
  const aside = document.querySelector<HTMLElement>('[data-workspace-left-panel]')!;
  const scroll = document.querySelector<HTMLElement>('[data-region="sidebar-scroll"]')!;
  expect(scroll.style.maskImage).toBe('');
  const written: string[] = [];
  const masks: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const style = (record.target as HTMLElement).style;
      for (let index = 0; index < style.length; index++) if (style[index].startsWith('--')) written.push(style[index]);
      if (record.target === scroll && scroll.style.maskImage) masks.push(scroll.style.maskImage);
    }
  });
  observer.observe(aside, { subtree: true, attributes: true, attributeFilter: ['style'] });
  const sidebar = document.querySelector<HTMLElement>('[data-region="left-sidebar"]')!;
  const listClasses = sidebar.className;
  // A row's trailing slot as ChatListPanel draws it (the rows themselves are stubbed here): the muted bell, the count.
  const trailing = document.createElement('span');
  trailing.className = 'gg-list-row-trailing';
  trailing.innerHTML = '<span class="gg-chat-row-muted">bell</span><span class="gg-chip">3</span><span>other</span>';
  scroll.append(trailing);
  document.querySelector<HTMLElement>('[data-testid="sidebar-fold"]')!.click();
  await expect.poll(() => aside.getBoundingClientRect().width, { timeout: 3000 }).toBe(72);
  observer.disconnect();
  expect([...new Set(written)]).toEqual([]);
  // The rail is the attribute alone under fixed rules: a class swap there restyled every row (rules ending in `*`, and an
  // inherited pointer-events on every row body).
  await expect.poll(() => sidebar.hasAttribute('data-sidebar-rail'), { timeout: 1000 }).toBe(true);
  expect(sidebar.className).toBe(listClasses);
  // The rules end in the count's own elements: the bell by its class; ❌ by tag (a span rule restyled every span in the rows).
  const [bell, chip, other] = [...trailing.children].map((child) => getComputedStyle(child).display);
  expect([getComputedStyle(trailing).position, bell, chip, other]).toEqual(['absolute', 'none', 'flex', 'block']);
  // The avatars' column stays; right of it the names' opacity, 0 on the rail.
  expect(masks.length).toBeGreaterThan(2);
  expect(scroll.style.maskImage).toMatch(/^linear-gradient\(to right, black 68px, color-mix\(in srgb, black 0(?:\.0+)?%, transparent\) 68px\)/);
  for (const testId of ['sidebar-create-agent', 'sidebar-session-history']) {
    expect(getComputedStyle(document.querySelector(`[data-testid="${testId}"]`)!.closest('[inert]')!).opacity).toBe('0');
  }
  document.querySelector<HTMLElement>('[data-testid="sidebar-fold"]')!.click();
  await expect.poll(() => aside.getBoundingClientRect().width, { timeout: 3000 }).toBeGreaterThan(200);
  await expect.poll(() => scroll.style.maskImage, { timeout: 3000 }).toBe('');
});

it('the rail flips in the frame the list\'s layer takes the rail\'s width, both ways: one paint, ❌ a re-render after it', async () => {
  await page.viewport(1000, 700);
  harness = createReactHarness();
  await harness.render(
    <SessionLocalizationProvider>
      <WorkspaceLayoutContextProvider>
        <WorkspaceLayout leftSidebar={<LeftSidebar />} mainContent={<div className="h-full">history</div>} />
      </WorkspaceLayoutContextProvider>
    </SessionLocalizationProvider>
  );
  const slot = document.querySelector<HTMLElement>('[data-panel-slot="list"]')!;
  // The size the list is laid out at (panel-track writes it on the content box, the list's layer fills that).
  const content = document.querySelector<HTMLElement>('[data-workspace-left-panel]')!.parentElement!;
  const sidebar = document.querySelector<HTMLElement>('[data-region="left-sidebar"]')!;
  // One mutation batch is one task: the frame loop's writes land together, a React commit lands in a batch of its own.
  const batches: { width: string; rail: boolean; flipped: boolean }[] = [];
  const observer = new MutationObserver((records) => batches.push({
    width: content.style.width,
    rail: sidebar.hasAttribute('data-sidebar-rail'),
    flipped: records.some((record) => record.attributeName === 'data-sidebar-rail'),
  }));
  observer.observe(slot, { subtree: true, attributes: true, attributeFilter: ['style', 'data-sidebar-rail'] });
  for (const [direction, rail] of [['collapse', true], ['expand', false]] as const) {
    batches.length = 0;
    document.querySelector<HTMLElement>('[data-testid="sidebar-fold"]')!.click();
    await expect.poll(() => sidebar.hasAttribute('data-sidebar-rail'), { timeout: 3000 }).toBe(rail);
    await new Promise(requestAnimationFrame);
    const flip = batches.findIndex((batch) => batch.flipped);
    const narrow = batches.findIndex((batch) => (batch.width === '72px') === rail);
    expect(flip, `${direction}: ${batches.map((batch) => `${batch.width}${batch.rail ? ' rail' : ''}`).join(' | ')}`).toBe(narrow);
  }
  observer.disconnect();
});

// Collapsed, the bell keeps a place on the rail: under 「»」 and over the 「+」, on the avatars' axis, one bell at a time.
// The rail has no room for its list: collapsing closes the list, and opening it from the rail expands the sidebar into it.
it('collapsed, the rail keeps the bell between 「»」 and the 「+」, and opening it expands the sidebar', async () => {
  const { setSidebarNotificationsOpen } = await import('@/lib/sidebarChatsBridge');
  await page.viewport(1000, 700);
  document.documentElement.dataset.theme = 'light';
  harness = createReactHarness();
  await harness.render(
    <div data-desktop-shell="" style={{ display: 'flex', width: '100vw', height: '100vh' }}>
      <div className="gugu-skin emlight" style={{ flex: 1, height: '100%' }}>
        <SessionLocalizationProvider>
          <WorkspaceLayoutContextProvider>
            <WorkspaceLayout leftSidebar={<LeftSidebar />} mainContent={<div className="h-full bg-background">history</div>} />
          </WorkspaceLayoutContextProvider>
        </SessionLocalizationProvider>
      </div>
    </div>
  );
  const aside = document.querySelector<HTMLElement>('[data-workspace-left-panel]')!;
  const fold = document.querySelector<HTMLElement>('[data-testid="sidebar-fold"]')!;
  const plus = document.querySelector<HTMLElement>('[data-testid="sidebar-create-menu"]')!;
  const bells = () => [...document.querySelectorAll<HTMLElement>('[data-notification-slot="toggle"]')];
  const shown = () => bells().filter((slot) => !slot.hidden);
  const railRow = document.querySelector<HTMLElement>('[data-sidebar-rail-bell]')!;
  expect(shown()).toHaveLength(1);
  expect(railRow.contains(shown()[0])).toBe(false);
  expect(railRow.getBoundingClientRect().height).toBe(0);

  setSidebarNotificationsOpen(true);
  fold.click();
  await expect.poll(() => aside.getBoundingClientRect().width, { timeout: 3000 }).toBe(72);
  await expect.poll(() => railRow.contains(shown()[0] ?? null)).toBe(true);
  expect(shown()).toHaveLength(1);
  expect(document.querySelector('[data-notification-slot="list"]:not([hidden])')).toBeNull();
  const panel = aside.getBoundingClientRect();
  const bell = railRow.getBoundingClientRect();
  expect(railRow.closest('[inert]')).toBeNull();
  // The count stands out over the bell's top-right corner: nothing between the bell and the sidebar clips it.
  for (let box: HTMLElement | null = railRow; box && box !== aside; box = box.parentElement) expect(getComputedStyle(box).overflowY, box.className).not.toBe('hidden');
  expect(bell.top).toBeGreaterThanOrEqual(fold.getBoundingClientRect().bottom);
  expect(plus.getBoundingClientRect().top).toBeGreaterThanOrEqual(bell.bottom);
  // The edge lands once it is within PANEL_LANDED_PX of the rail, while the bell's and the 「+」's rows follow the spring's
  // own progress, whose sub-pixel tail runs on a little longer: both are on the axis where that motion rests.
  await expect.poll(() => railRow.getBoundingClientRect().left + 20 + 16 - panel.left).toBe(36);
  await expect.poll(() => plus.getBoundingClientRect().left + 16 - panel.left).toBe(36);

  setSidebarNotificationsOpen(true);
  await expect.poll(() => aside.getBoundingClientRect().width, { timeout: 3000 }).toBeGreaterThan(200);
  await expect.poll(() => document.querySelector('[data-notification-slot="list"]:not([hidden])')).not.toBeNull();
  await expect.poll(() => railRow.getBoundingClientRect().height, { timeout: 3000 }).toBe(0);
  setSidebarNotificationsOpen(false);
});
