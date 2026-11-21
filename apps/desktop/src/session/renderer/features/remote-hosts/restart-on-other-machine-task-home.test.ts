// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';

// #3425 Restarting while the saved view is a session on another machine: the account copy of that machine's projects
// (the only thing known before its link is open) never lists its hidden task workspace, so a task started there without a
// folder used to be read as "deleted" the moment the roster attached, and the person landed on Home.
vi.mock('@/lib/deviceProjects', () => ({ listMyAccountProjects: async () => [], listMyDeviceProjects: async () => ({}) }));

const HOME = '00000000-0000-4000-8000-000000000001';
const ordinary = {
  localProjectId: '11111111-1111-4111-8111-111111111111', name: 'repo', rootPath: '/srv/repo', createdAt: '2026-10-01T08:00:00.000Z', chatId: null,
  folders: [{ workspaceId: 'ws-root', kind: 'root' as const, path: '/srv/repo', attachedAt: null }],
};
const row = (conversationId: string, projectId: string) => ({
  conversationId, projectId, projectName: 'x', title: 'task', harness: 'claude', runtime: 'acp' as const, agentStatus: null, lastInteractedAt: null, supported: true,
});
const machine = (): RemoteHostDevice => ({
  id: 'dev-other', label: 'Linux 3', isOnline: true, platform: 'linux', lastSeenAt: null, directTerminal: false,
  projects: [ordinary], sessionDigest: [row('s-task', HOME), row('s-proj', ordinary.localProjectId)],
});

describe('restart with the last view on a session of another machine, before its link is open', () => {
  beforeEach(() => vi.resetModules());

  async function restart(projectId: string, sessionId: string) {
    const { appState } = await import('@renderer/lib/stores/app-state');
    const { sessionViewCanActivate } = await import('@renderer/features/sessions/session-view-guard');
    const { remoteHostsStore } = await import('./remote-hosts-store');
    const { installRemoteHostsBridge } = await import('@/session/shared/remote-hosts');
    for (const id of ['home', 'new-session', 'session', 'screen'] as const) appState.navigation.registerView(id);
    appState.navigation.registerGuard('session', sessionViewCanActivate);
    // the saved view comes back first: the machine roster is not attached yet
    appState.navigation.restoreSnapshot({ currentViewId: 'session', viewParams: { session: { projectId, sessionId } } });
    expect(appState.navigation.currentViewId).toBe('session');
    const off = installRemoteHostsBridge({
      listDevices: () => [machine()],
      subscribeDevices: () => () => {},
      pickFolder: async () => null,
    } as never);
    remoteHostsStore.start();
    return { appState, off };
  }

  it('keeps a task of that machine\'s hidden task workspace', async () => {
    const { appState, off } = await restart(`${HOME}~dev-other`, 's-task');
    try {
      expect(appState.navigation.currentViewId).toBe('session');
      expect(appState.navigation.viewParamsStore.session).toEqual({ projectId: `${HOME}~dev-other`, sessionId: 's-task' });
    } finally { off(); }
  });

  it('keeps a task of an ordinary project of that machine (its account copy lists it)', async () => {
    const { appState, off } = await restart(ordinary.localProjectId, 's-proj');
    try {
      expect(appState.navigation.currentViewId).toBe('session');
    } finally { off(); }
  });

  it('still sends the person home when the project is gone from the account copy', async () => {
    const { appState, off } = await restart('22222222-2222-4222-8222-222222222222', 's-gone');
    try {
      expect(appState.navigation.currentViewId).toBe('home');
    } finally { off(); }
  });

  // #3433 The roster is not always there when the session page starts: the bridge can be installed after `start()`, or be
  // installed while the device list is still being read (nothing seeds it at boot when the cached list is too big to keep).
  // An empty roster then says nothing, and a restored view of another machine's project must not be judged deleted.
  describe('while the machine roster is not complete', () => {
    async function boot(projectId: string, sessionId: string) {
      const { appState } = await import('@renderer/lib/stores/app-state');
      const { sessionViewCanActivate } = await import('@renderer/features/sessions/session-view-guard');
      const { remoteHostsStore } = await import('./remote-hosts-store');
      const { installRemoteHostsBridge } = await import('@/session/shared/remote-hosts');
      for (const id of ['home', 'new-session', 'session', 'screen'] as const) appState.navigation.registerView(id);
      appState.navigation.registerGuard('session', sessionViewCanActivate);
      appState.navigation.restoreSnapshot({ currentViewId: 'session', viewParams: { session: { projectId, sessionId } } });
      return { appState, remoteHostsStore, installRemoteHostsBridge };
    }
    const second = (): RemoteHostDevice => ({
      id: 'dev-second', label: 'Mac 2', isOnline: true, platform: 'darwin', lastSeenAt: null, directTerminal: false,
      projects: [{ ...ordinary, localProjectId: '33333333-3333-4333-8333-333333333333', name: 'second' }], sessionDigest: [],
    });

    it('start() before the bridge is installed: an ordinary project of another machine stays, then the roster merges in', async () => {
      const { appState, remoteHostsStore, installRemoteHostsBridge } = await boot(ordinary.localProjectId, 's-proj');
      remoteHostsStore.start();
      expect(appState.navigation.currentViewId).toBe('session');
      const off = installRemoteHostsBridge({ listDevices: () => [machine()], subscribeDevices: () => () => {}, pickFolder: async () => null } as never);
      try {
        expect(appState.navigation.currentViewId).toBe('session');
        expect(appState.projects.projects.has(ordinary.localProjectId)).toBe(true);
      } finally { off(); }
    });

    it('the bridge is installed but the device list is not read yet: stays; once read, a project of the roster stays and one that is gone goes Home', async () => {
      for (const [projectId, sessionId, view] of [[ordinary.localProjectId, 's-proj', 'session'], ['22222222-2222-4222-8222-222222222222', 's-gone', 'home']] as const) {
        vi.resetModules();
        const { appState, remoteHostsStore, installRemoteHostsBridge } = await boot(projectId, sessionId);
        let read = false;
        let roster: RemoteHostDevice[] = [];
        const listeners = new Set<() => void>();
        const off = installRemoteHostsBridge({
          devicesRead: () => read, listDevices: () => roster,
          subscribeDevices: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)), pickFolder: async () => null,
        } as never);
        try {
          remoteHostsStore.start();
          expect(appState.navigation.currentViewId).toBe('session');
          read = true; roster = [machine()];
          listeners.forEach((listener) => listener());
          expect(appState.navigation.currentViewId).toBe(view);
        } finally { off(); }
      }
    });

    it('the device list is read and has no other machine: a restored view of a project nobody has goes Home', async () => {
      const { appState, remoteHostsStore, installRemoteHostsBridge } = await boot('22222222-2222-4222-8222-222222222222', 's-gone');
      let read = false;
      const listeners = new Set<() => void>();
      const off = installRemoteHostsBridge({
        devicesRead: () => read, listDevices: () => [], subscribeDevices: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)), pickFolder: async () => null,
      } as never);
      try {
        remoteHostsStore.start();
        expect(appState.navigation.currentViewId).toBe('session');
        read = true;
        listeners.forEach((listener) => listener());
        expect(appState.navigation.currentViewId).toBe('home');
      } finally { off(); }
    });

    it('two other machines: the first one merged does not judge the second one\'s project deleted', async () => {
      const { appState, remoteHostsStore, installRemoteHostsBridge } = await boot('33333333-3333-4333-8333-333333333333', 's-second');
      const off = installRemoteHostsBridge({ listDevices: () => [machine(), second()], subscribeDevices: () => () => {}, pickFolder: async () => null } as never);
      try {
        remoteHostsStore.start();
        expect(appState.navigation.currentViewId).toBe('session');
        expect(appState.projects.projects.has('33333333-3333-4333-8333-333333333333')).toBe(true);
      } finally { off(); }
    });
  });
});
