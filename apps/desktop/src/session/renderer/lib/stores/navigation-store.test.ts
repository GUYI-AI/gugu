import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarStore } from '@renderer/features/sidebar/sidebar-store';

vi.mock('@renderer/lib/modal/modal-store', () => ({
  modalStore: { closeModal: vi.fn() },
}));

vi.mock('./app-state', () => ({
  appState: {
    history: { push: vi.fn() },
    sidebar: { revealActiveSession: vi.fn() },
  },
}));

const { NavigationStore } = await import('./navigation-store');
const { appState } = await import('./app-state');

function buildStore() {
  const store = new NavigationStore();
  store.registerView('home');
  store.registerView('chat');
  store.registerView('apps', { transientParams: ['installedSection', 'installedDeviceId'] });
  return store;
}

describe('NavigationStore.restoreSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores a snapshot whose view is registered', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'chat',
      viewParams: { chat: { chatId: 'p1' } },
    });
    expect(store.currentViewId).toBe('chat');
    expect(store.viewParamsStore.chat).toEqual({ chatId: 'p1' });
  });

  it('falls back to home when the persisted view is not in the registry', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'phantom-view-from-old-build',
      viewParams: { chat: { chatId: 'p1' } },
    });
    expect(store.currentViewId).toBe('home');
  });

  it('strips viewParams entries whose key is not a registered view', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'home',
      viewParams: {
        chat: { chatId: 'p1' },
        ghostView: { stale: true },
      },
    });
    expect(store.viewParamsStore.chat).toEqual({ chatId: 'p1' });
    expect((store.viewParamsStore as Record<string, unknown>).ghostView).toBeUndefined();
  });

  // 设置从前是本页的一个视图,现在是壳的弹窗(product spec):旧快照里停在它上面的,与任何认不出来的视图一样回首页。
  it('a snapshot left on the old settings view boots into home', () => {
    const store = buildStore();
    store.restoreSnapshot({ currentViewId: 'settings', viewParams: { settings: { tab: 'storage' } } });
    expect(store.currentViewId).toBe('home');
    expect((store.viewParamsStore as Record<string, unknown>).settings).toBeUndefined();
  });

  it('honors a guard redirect after a valid view is restored', () => {
    const store = buildStore();
    store.registerGuard('chat', () => ({ ok: false, redirect: 'home' }));
    store.restoreSnapshot({
      currentViewId: 'chat',
      viewParams: { chat: { chatId: 'gone' } },
    });
    expect(store.currentViewId).toBe('home');
  });

  it('discards the retired library view and its parameters on restore', () => {
    const store = buildStore();
    store.restoreSnapshot({ currentViewId: 'library', viewParams: { library: { tab: 'prompts' } } });
    expect(store.currentViewId).toBe('home');
    expect(store.snapshot.viewParams).not.toHaveProperty('library');
  });
});

describe('NavigationStore transient view params', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops a transient param when the view is left, and keeps the remembered one', () => {
    const store = buildStore();
    store.navigate('apps', { marketPage: 'connectors', installedSection: 'connectors', installedDeviceId: 'other-device' });
    expect(store.viewParamsStore.apps).toEqual({ marketPage: 'connectors', installedSection: 'connectors', installedDeviceId: 'other-device' });

    store.navigate('home');
    expect(store.viewParamsStore.apps).toEqual({ marketPage: 'connectors' });
  });

  it('does not reopen installed connectors on the next visit', () => {
    const store = buildStore();
    store.navigate('apps', { marketPage: 'connectors', installedSection: 'connectors' });
    store.navigate('home');
    store.navigate('apps');
    expect(store.viewParamsStore.apps).toEqual({ marketPage: 'connectors' });
    expect(store.viewParamsStore.apps?.installedSection).toBeUndefined();
  });

  it('never restores a transient param from a snapshot', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'apps',
      viewParams: {
        apps: { marketPage: 'connectors', installedSection: 'connectors' },
        chat: { chatId: 'p1' },
      },
    });
    expect(store.viewParamsStore.apps).toEqual({ marketPage: 'connectors' });
    // 阴控:没声明为转瞬的参数一个都不许被顺手丢掉。
    expect(store.viewParamsStore.chat).toEqual({ chatId: 'p1' });
  });

  it('leaves views that declared no transient params untouched', () => {
    const store = buildStore();
    store.navigate('chat', { chatId: 'p1' });
    store.navigate('home');
    expect(store.viewParamsStore.chat).toEqual({ chatId: 'p1' });
  });
});

describe('NavigationStore transient params vs. history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never records a transient param into the back stack', () => {
    const store = buildStore();
    store.navigate('apps', { marketPage: 'connectors', installedSection: 'connectors' });
    const pushed = (appState.history.push as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => call[0] as { viewId: string; params: Record<string, unknown> })
      .filter((entry) => entry.viewId === 'apps');
    expect(pushed).toHaveLength(1);
    // 后退回到的是位置,不是当时那次意图 —— 否则用户关掉的抽屉会被后退键请回来。
    expect(pushed[0].params).toEqual({ marketPage: 'connectors' });
  });

  it('replaying that history entry cannot resurrect the drawer', () => {
    const store = buildStore();
    store.navigate('apps', { marketPage: 'connectors', installedSection: 'connectors' });
    store.navigate('home');
    const entry = (appState.history.push as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => call[0] as { viewId: string; params: Record<string, unknown> })
      .find((e) => e.viewId === 'apps');
    // 这就是 nav-buttons 的后退所做的事。
    store._applyNavigation('apps', entry!.params as never);
    expect(store.viewParamsStore.apps).toEqual({ marketPage: 'connectors' });
  });
});

describe('NavigationStore preserves manual sidebar disclosure', () => {
  it('keeps collapsed and expanded choices through session/chat navigation and restoration', () => {
    const original = appState.sidebar;
    const sidebar = new SidebarStore({ projects: new Map() } as never);
    Object.assign(appState, { sidebar });
    try {
      sidebar.toggleSessionExpanded('open-parent');
      const before = structuredClone(sidebar.snapshot);
      const store = buildStore();
      store.registerView('session');
      for (const projectId of ['folded-project', 'open-project']) {
        store.navigate('session', { projectId, sessionId: 'parent' });
        store.navigate('chat', { chatId: projectId });
        store.navigate('home');
        store.restoreSnapshot({ currentViewId: 'session', viewParams: { session: { projectId, sessionId: 'child' } } });
        expect(sidebar.snapshot).toEqual(before);
      }
    } finally { Object.assign(appState, { sidebar: original }); }
  });
});
