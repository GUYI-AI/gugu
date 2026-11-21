import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sidebarOf } from '@renderer/features/sidebar/mirror-account-projects.testing';

vi.mock('@renderer/lib/modal/modal-store', () => ({
  modalStore: { closeModal: vi.fn() },
}));

vi.mock('./app-state', () => ({
  appState: {
    history: { push: vi.fn(), replaceCurrent: vi.fn() },
    sidebar: { revealActiveSession: vi.fn() },
  },
}));

const { NavigationStore } = await import('./navigation-store');
const { appState } = await import('./app-state');

function buildStore() {
  const store = new NavigationStore();
  store.registerView('home');
  store.registerView('project');
  store.registerView('apps', { placeParams: ['location'], transientParams: ['agentDetail', 'agentDetailFrom'] });
  return store;
}

describe('NavigationStore.restoreSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores a snapshot whose view is registered', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'project',
      viewParams: { project: { projectId: 'p1' } },
    });
    expect(store.currentViewId).toBe('project');
    expect(store.viewParamsStore.project).toEqual({ projectId: 'p1' });
  });

  it('falls back to home when the persisted view is not in the registry', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'phantom-view-from-old-build',
      viewParams: { project: { projectId: 'p1' } },
    });
    expect(store.currentViewId).toBe('home');
  });

  it('strips viewParams entries whose key is not a registered view', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'home',
      viewParams: {
        project: { projectId: 'p1' },
        ghostView: { stale: true },
      },
    });
    expect(store.viewParamsStore.project).toEqual({ projectId: 'p1' });
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
    store.registerGuard('project', () => ({ ok: false, redirect: 'home' }));
    store.restoreSnapshot({
      currentViewId: 'project',
      viewParams: { project: { projectId: 'gone' } },
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

const agentDetail = { kind: 'agent-app-detail', agentId: 'claude' } as const;
const pushedApps = () => (appState.history.push as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .map((call) => call[0] as { viewId: string; params: Record<string, unknown>; place?: string })
  .filter((entry) => entry.viewId === 'apps');

describe('NavigationStore transient view params', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops a transient param when the view is left, and keeps the remembered one', () => {
    const store = buildStore();
    store.navigate('apps', { location: { tab: 'connectors' }, agentDetail, agentDetailFrom: 'apps' });
    expect(store.viewParamsStore.apps).toEqual({ location: { tab: 'connectors' }, agentDetail, agentDetailFrom: 'apps' });

    store.navigate('home');
    expect(store.viewParamsStore.apps).toEqual({ location: { tab: 'connectors' } });
  });

  it('coming back without params returns to the remembered place, without the dialog', () => {
    const store = buildStore();
    store.navigate('apps', { location: { tab: 'connectors', installed: { section: 'connectors' } }, agentDetail });
    store.navigate('home');
    store.navigate('apps');
    expect(store.viewParamsStore.apps).toEqual({ location: { tab: 'connectors', installed: { section: 'connectors' } } });
  });

  it('never restores a transient param from a snapshot', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'apps',
      viewParams: {
        apps: { location: { tab: 'connectors' }, agentDetail },
        project: { projectId: 'p1' },
      },
    });
    expect(store.viewParamsStore.apps).toEqual({ location: { tab: 'connectors' } });
    // 阴控:没声明为转瞬的参数一个都不许被顺手丢掉。
    expect(store.viewParamsStore.project).toEqual({ projectId: 'p1' });
  });

  it('leaves views that declared no transient params untouched', () => {
    const store = buildStore();
    store.navigate('project', { projectId: 'p1' });
    store.navigate('home');
    expect(store.viewParamsStore.project).toEqual({ projectId: 'p1' });
  });
});

describe('NavigationStore transient params vs. history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never records a transient param into the back stack', () => {
    const store = buildStore();
    store.navigate('apps', { location: { tab: 'connectors' }, agentDetail });
    const pushed = pushedApps();
    expect(pushed).toHaveLength(1);
    // 后退回到的是位置,不是当时那次意图 —— 否则用户关掉的弹窗会被后退键请回来。
    expect(pushed[0].params).toEqual({ location: { tab: 'connectors' } });
  });

  it('replaying that history entry cannot resurrect the dialog', () => {
    const store = buildStore();
    store.navigate('apps', { location: { tab: 'connectors' }, agentDetail });
    store.navigate('home');
    // 这就是 nav-buttons 的后退所做的事。
    store._applyNavigation('apps', pushedApps()[0]!.params as never);
    expect(store.viewParamsStore.apps).toEqual({ location: { tab: 'connectors' } });
  });
});

describe('NavigationStore place params', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('each place a view is navigated to is recorded with its own place', () => {
    const store = buildStore();
    store.navigate('apps', { location: { tab: 'market' } });
    store.navigate('apps', { location: { tab: 'market', detail: { page: 'market', extensionId: 'notes' } } });
    const [list, page] = pushedApps();
    expect(list!.place).not.toEqual(page!.place);
  });

  it('a move inside the current view rewrites the step it is on instead of adding one', () => {
    const store = buildStore();
    store.navigate('apps', { location: { tab: 'market' } });
    store.updateViewParams('apps', (params) => ({ ...params, location: { tab: 'agents' as const }, agentDetail }));
    expect(pushedApps()).toHaveLength(1);
    expect(appState.history.replaceCurrent).toHaveBeenCalledWith(expect.objectContaining({
      viewId: 'apps', params: { location: { tab: 'agents' } },
    }));
  });

  it('a move while elsewhere only changes the remembered place', () => {
    const store = buildStore();
    store.navigate('home');
    store.updateViewParams('apps', { location: { tab: 'agents' } });
    expect(appState.history.replaceCurrent).not.toHaveBeenCalled();
    expect(store.viewParamsStore.apps).toEqual({ location: { tab: 'agents' } });
  });
});

describe('NavigationStore preserves manual sidebar disclosure', () => {
  it('keeps collapsed and expanded choices through session/project navigation and restoration', () => {
    const original = appState.sidebar;
    const sidebar = sidebarOf({ projects: new Map() } as never);
    Object.assign(appState, { sidebar });
    try {
      sidebar.ensureProjectExpanded('open-project');
      sidebar.toggleSessionExpanded('open-parent');
      const before = structuredClone(sidebar.snapshot);
      const store = buildStore();
      store.registerView('session');
      for (const projectId of ['folded-project', 'open-project']) {
        store.navigate('session', { projectId, sessionId: 'parent' });
        store.navigate('project', { projectId });
        store.navigate('home');
        store.restoreSnapshot({ currentViewId: 'session', viewParams: { session: { projectId, sessionId: 'child' } } });
        expect(sidebar.snapshot).toEqual(before);
      }
    } finally { Object.assign(appState, { sidebar: original }); }
  });
});
