// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/core/sessions/sessions';
import { foldersChangedChannel, type FolderRecord } from '@shared/core/folders/folders';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import type { LocalProject } from '@shared/projects';
// 这个模块被 vi.mock 掉了,导进来拿到的就是那份替身 —— 挂载末尾补跑的 revalidate 打在它上面。
import { appState } from '@renderer/lib/stores/app-state';
import { createUnmountedProject } from './project';
import { folderAsProject } from '@renderer/features/folders/folder-project';
import { ProjectManagerStore } from './project-manager';
import { isWorkspaceProject } from '@renderer/features/sessions/session-home-project-constants';
import type { CanonicalPath } from '@gugu/session-shared/canonical-path';

const mocks = vi.hoisted(() => ({
  listAllFolders: vi.fn(),
  getUnarchivedSession: vi.fn(),
  logError: vi.fn(),
  openProject: vi.fn(),
  eventOn: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => {
  const mod = {
  events: {
    on: mocks.eventOn,
  },
  rpc: {
    sessions: {
      getUnarchivedSession: mocks.getUnarchivedSession,
    },
    folders: {
      listAllFolders: mocks.listAllFolders,
    },
    folderRuntime: {
      openFolder: mocks.openProject,
    },
  },
  };
  // #6264 一套工作台:按机器路由的那几个口,替身里都落到本机这一份。
  return {
    rpcOn: () => mod.rpc,
    onMachineEvent: () => () => {},
    ...mod,
  };
});

// 到别的机器的线:测试里手动开合(ensureMounted 等它连上才挂)。
const links = vi.hoisted(() => ({ state: new Map<string, string>(), listeners: new Map<string, Set<() => void>>() }));
vi.mock('@renderer/lib/machine-clients', () => ({
  machineLinkState: (deviceId: string) => links.state.get(deviceId) ?? 'closed',
  subscribeMachineLink: (deviceId: string, listener: () => void) => {
    const set = links.listeners.get(deviceId) ?? new Set<() => void>();
    links.listeners.set(deviceId, set);
    set.add(listener);
    return () => set.delete(listener);
  },
  // 这屏的摆法(screen-layout-actions)经会话名那张表引到它:载入时就要有。
  onMachineLinkOpen: () => () => {},
}));
function setLink(deviceId: string, state: string): void {
  links.state.set(deviceId, state);
  for (const listener of [...(links.listeners.get(deviceId) ?? [])]) listener();
}

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      currentViewId: 'home',
      navigate: vi.fn(),
      revalidate: vi.fn(),
      updateViewParams: vi.fn(),
      viewParamsStore: {},
    },
  },
}));

vi.mock('@renderer/lib/stores/view-state-cache', () => ({
  viewStateCache: {
    read: vi.fn(() => undefined),
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    sessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

vi.mock('@renderer/utils/logger', () => ({
  log: { error: mocks.logError },
}));

function localProject(overrides: Partial<LocalProject> = {}): LocalProject {
  return {
    type: 'local',
    id: 'project-id',
    name: 'Project',
    path: '/project' as CanonicalPath,
    baseRef: 'main',
    repositoryWorkspaceId: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

function folderRecord(overrides: Partial<FolderRecord> = {}): FolderRecord {
  return {
    id: 'folder-id',
    path: '/project',
    chatId: 'g1',
    sort: 1,
    gitless: false,
    baseRef: 'main',
    attachedAt: null,
    branch: null,
    sessionIds: [],
    taskHome: false,
    ...overrides,
  };
}

function okProject(project: LocalProject) {
  return { success: true as const, data: project };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'conversation-id',
    projectId: 'project-id',
    providerId: 'codex',
    title: 'Conversation',
    lastInteractedAt: null,
    ...overrides,
  };
}

/**
 * 一个刚好够 mountProject 走完的项目替身:`state: 'unmounted'` 让 isUnmountedProject 认它,
 * transitionToMounted 挂上一个假的 sessionManager,好让挂载末尾那段拿得到它。
 */
function mountableProject(sessionManager: unknown) {
  return {
    state: 'unmounted',
    phase: 'idle',
    data: localProject({ id: 'project-id' }),
    error: undefined,
    errorCode: undefined,
    mountedProject: undefined as unknown,
    // ⚠️ 写 `this` 而不是闭包里的那个对象:projects 是 observable map,塞进去的普通对象会被 MobX
    // 包成代理。闭包写回的是原对象、被测代码读的是代理 —— 于是「挂载完了」这件事它永远看不见,
    // 整段挂载末尾被静默跳过,判据看起来像是功能没跑。
    transitionToMounted(this: { state: string; mountedProject: unknown }) {
      this.state = 'mounted';
      this.mountedProject = { sessionManager };
    },
  };
}

describe('挂载末尾:任务列表到位之后补跑路由校验', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses the effective Git capability before mounting an old project', async () => {
    const sessionManager = { loadSessions: vi.fn(async () => {}), provisionSession: vi.fn() };
    const store = new ProjectManagerStore();
    store.projects.set('project-id', mountableProject(sessionManager) as never);
    mocks.openProject.mockResolvedValue({ success: true, data: { gitless: true } });

    await store.mountProject('project-id');

    // The host's answer wins over the record; the repository's workspace is the folder itself.
    expect(store.projects.get('project-id')?.data).toMatchObject({
      baseRef: null, repositoryWorkspaceId: 'project-id',
    });
  });

  // 路由守卫判的是任务列表,而它**第一次**跑是在冷启动恢复快照那一刻 —— 那时项目还没挂载、
  // sessionManager 还不存在,只能一律放行,之后再也不跑。少了这一次补跑,恢复到一个已归档的任务
  // 就会原样停在那儿。顺序也要钉死:先校验、后 provision,反过来就是先把归档任务复活、再问
  // 该不该去。
  it('先 loadSessions、再 revalidate、最后才 provision', async () => {
    const order: string[] = [];
    const sessionManager = {
      loadSessions: vi.fn(() => {
        order.push('load');
        return Promise.resolve();
      }),
      provisionSession: vi.fn(() => {
        order.push('provision');
        return Promise.resolve();
      }),
    };
    const store = new ProjectManagerStore();
    store.projects.set('project-id', mountableProject(sessionManager) as never);
    mocks.openProject.mockResolvedValue(okProject(localProject({ id: 'project-id' })));
    const nav = appState.navigation as unknown as {
      currentViewId: string;
      viewParamsStore: Record<string, unknown>;
      revalidate: ReturnType<typeof vi.fn>;
    };
    nav.currentViewId = 'session';
    nav.viewParamsStore = { session: { projectId: 'project-id', sessionId: 'session-id' } };
    nav.revalidate.mockImplementation(() => order.push('revalidate'));

    await store.mountProject('project-id');

    expect(order).toEqual(['load', 'revalidate', 'provision']);
  });

  // 校验把人踢走了(比如那项任务已归档),就不该再去 provision 它 —— 那正是「把归档任务反向复活」。
  it('校验把人送走之后,不再 provision 那项任务', async () => {
    const sessionManager = {
      loadSessions: vi.fn(() => Promise.resolve()),
      provisionSession: vi.fn(() => Promise.resolve()),
    };
    const store = new ProjectManagerStore();
    store.projects.set('project-id', mountableProject(sessionManager) as never);
    mocks.openProject.mockResolvedValue(okProject(localProject({ id: 'project-id' })));
    const nav = appState.navigation as unknown as {
      currentViewId: string;
      viewParamsStore: Record<string, unknown>;
      revalidate: ReturnType<typeof vi.fn>;
    };
    nav.currentViewId = 'session';
    nav.viewParamsStore = { session: { projectId: 'project-id', sessionId: 'session-id' } };
    nav.revalidate.mockImplementation(() => {
      nav.currentViewId = 'project';
    });

    await store.mountProject('project-id');

    expect(sessionManager.provisionSession).not.toHaveBeenCalled();
  });
});

describe('ProjectManagerStore folders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventOn.mockReturnValue(vi.fn());
    mocks.listAllFolders.mockResolvedValue([]);
    mocks.getUnarchivedSession.mockResolvedValue([]);
    mocks.openProject.mockReturnValue(new Promise(() => {}));
  });

  it('loads and mounts a folder recorded outside the renderer store', async () => {
    const recorded = folderRecord({ id: 'imported-folder' });
    mocks.listAllFolders.mockResolvedValueOnce([recorded]);
    const store = new ProjectManagerStore();
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);

    await store.ensureProjectLoaded(recorded.id);

    expect(store.projects.get(recorded.id)?.data).toEqual(folderAsProject(recorded));
    expect(mount).toHaveBeenCalledWith(recorded.id);
  });

  // 这台电脑的文件夹变了:重读清单 —— 新的加进来并挂上,类别跟着变(#609),没有了的拿掉。
  it('follows this computer’s folder list when it says its folders changed', async () => {
    const store = new ProjectManagerStore();
    const gone = folderRecord({ id: 'gone-folder' });
    const home = folderRecord({ id: 'home-folder', chatId: null });
    store.projects.set(gone.id, createUnmountedProject(folderAsProject(gone), 'idle'));
    store.projects.set(home.id, createUnmountedProject(folderAsProject(home), 'idle'));
    expect(store.projects.get(home.id)?.data?.kind).toBe('workspace');
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    const handler = mocks.eventOn.mock.calls.find(([channel]) => channel === foldersChangedChannel)?.[1];
    if (!handler) throw new Error('Expected folders-changed event subscription');
    const added = folderRecord({ id: 'added-folder' });
    mocks.listAllFolders.mockResolvedValueOnce([{ ...home, chatId: 'g1' }, added]);
    const revalidate = vi.mocked(appState.navigation.revalidate);
    revalidate.mockClear();

    handler({ chatIds: ['g1'] });
    await vi.waitFor(() => expect(revalidate).toHaveBeenCalledTimes(1));

    expect(store.projects.get(added.id)?.data).toEqual(folderAsProject(added));
    expect(mount).toHaveBeenCalledWith(added.id);
    expect(store.projects.get(home.id)?.data?.kind).toBeUndefined();
    expect(store.projects.has(gone.id)).toBe(false);
  });

  it('hands a session created in a project that is not mounted yet to its task manager once it mounts', async () => {
    const store = new ProjectManagerStore();
    const createdSession = session({ projectId: 'external-project' });
    const accepted = Promise.withResolvers<void>();
    const acceptCreatedSession = vi.fn(() => accepted.resolve());
    const ensureProjectLoaded = vi
      .spyOn(store, 'ensureProjectLoaded')
      .mockImplementation(async (projectId) => {
        store.projects.set(
          projectId,
          { mountedProject: { sessionManager: { acceptCreatedSession } } } as never
        );
      });
    const handler = mocks.eventOn.mock.calls.find(
      ([channel]) => channel === sessionCreatedChannel
    )?.[1];
    if (!handler) throw new Error('Expected conversation-created event subscription');

    handler({ session: createdSession });

    await accepted.promise;
    expect(acceptCreatedSession).toHaveBeenCalledWith(createdSession);
    expect(ensureProjectLoaded).toHaveBeenCalledWith('external-project');
  });

  it('fails loudly when a folder is absent from its machine', async () => {
    const store = new ProjectManagerStore();

    await expect(store.ensureProjectLoaded('missing-project')).rejects.toThrow(
      'Folder missing-project was not found on its machine'
    );
  });

  it('removes its event subscriptions once on dispose', () => {
    const disposeFoldersChangedEvent = vi.fn();
    const disposeSessionCreatedEvent = vi.fn();
    mocks.eventOn
      .mockReturnValueOnce(disposeFoldersChangedEvent)
      .mockReturnValueOnce(disposeSessionCreatedEvent);
    const store = new ProjectManagerStore();

    store.dispose();
    store.dispose();

    expect(disposeFoldersChangedEvent).toHaveBeenCalledTimes(1);
    expect(disposeSessionCreatedEvent).toHaveBeenCalledTimes(1);
  });

  it('records path-access-blocked so the panel can offer permission recovery', async () => {
    // 权限挡住时 openProject 会明确报 path-access-blocked;若这里退化成通用 error,
    // 面板就只剩一句 timeout、没有任何恢复动作(gugu #3611)。
    const project = localProject();
    mocks.openProject.mockResolvedValue({
      success: false,
      error: { type: 'path-access-blocked', path: project.path },
    });
    const store = new ProjectManagerStore();
    store.projects.set(project.id, createUnmountedProject(project, 'idle'));

    await store.mountProject(project.id);

    const projectStore = store.projects.get(project.id);
    expect(projectStore?.phase).toBe('error');
    expect(projectStore?.errorCode).toBe('path-access-blocked');
    expect(projectStore?.error).toBe(project.path);
  });
});

describe('remote project classification on reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventOn.mockReturnValue(vi.fn());
  });

  it.each([false, true])('refreshes a known project category without replacing its task state (mounted=%s)', async (mounted) => {
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const deviceId = `classification-device-${mounted}`;
    const project = localProject({ id: `classification-project-${mounted}` });
    const store = new ProjectManagerStore();
    store.syncMachineProjects(deviceId, [project]);
    const known = store.projects.get(project.id)!;
    if (mounted) {
      known.state = 'mounted';
      known.mountedProject = { sessionManager: { sessions: new Map([['task', { id: 'task' }]]) }, dispose: vi.fn() } as never;
    }
    const taskState = known.mountedProject;
    try {
      store.syncMachineProjects(deviceId, [{ ...project, kind: 'workspace' }]);
      expect(isWorkspaceProject(known)).toBe(true);
      expect(store.projects.get(project.id)).toBe(known);
      expect(known.mountedProject).toBe(taskState);
      if (taskState) expect(taskState.dispose).not.toHaveBeenCalled();
      expect(mocks.openProject).not.toHaveBeenCalled();
      const updated = known.data;
      store.syncMachineProjects(deviceId, [{ ...project, kind: 'workspace' }]);
      expect(known.data).toBe(updated);

      // The user may later explicitly add this same folder as a real project.
      store.syncMachineProjects(deviceId, [project]);
      expect(isWorkspaceProject(known)).toBe(false);
      expect(known.mountedProject).toBe(taskState);
    } finally {
      store.dispose();
      machineRegistry.forgetMachine(deviceId);
    }
  });

  it('does not re-point a task at a project this desktop has no entry for (the other machine\'s hidden task workspace is in no account copy)', async () => {
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const deviceId = 'other-config-device';
    const home = '00000000-0000-4000-8000-000000000001';
    const ordinary = localProject({ id: 'other-config-project' });
    const store = new ProjectManagerStore();
    const saved = appState.navigation.viewParamsStore;
    appState.navigation.viewParamsStore = { session: { projectId: home, sessionId: 'local-task' } };
    try {
      // that machine's session list names the same task under its hidden task workspace, which its project list does not carry
      store.syncMachineProjects(deviceId, [ordinary], [{ conversationId: 'local-task', projectId: `${home}~${deviceId}` }]);
      expect(appState.navigation.updateViewParams).not.toHaveBeenCalled();
    } finally {
      appState.navigation.viewParamsStore = saved;
      vi.mocked(appState.navigation.updateViewParams).mockReset();
      store.dispose();
      machineRegistry.forgetMachine(deviceId);
    }
  });

  it('aligns a moved task after registering its new project and before removing the old one or checking the route', async () => {
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const deviceId = 'migrated-assistant-device';
    const old = localProject({ id: 'legacy-assistant-project' });
    const tasks = localProject({ id: 'machine-task-workspace', kind: 'workspace' });
    const store = new ProjectManagerStore();
    store.syncMachineProjects(deviceId, [old]);
    const saved = appState.navigation.viewParamsStore;
    appState.navigation.viewParamsStore = { session: { projectId: old.id, sessionId: 'moved-assistant' } };
    const order: string[] = [];
    vi.mocked(appState.navigation.updateViewParams).mockImplementation(() => {
      expect(store.projects.has(old.id)).toBe(true);
      expect(store.projects.has(tasks.id)).toBe(true);
      order.push('align');
    });
    vi.mocked(appState.navigation.revalidate).mockImplementation(() => order.push('revalidate'));
    try {
      store.syncMachineProjects(deviceId, [tasks], [{ conversationId: 'moved-assistant', projectId: tasks.id }]);
      expect(appState.navigation.updateViewParams).toHaveBeenCalledWith('session', { projectId: tasks.id, sessionId: 'moved-assistant' });
      expect(order).toEqual(['align', 'revalidate']);
      expect(store.projects.has(old.id)).toBe(false);
    } finally {
      appState.navigation.viewParamsStore = saved;
      vi.mocked(appState.navigation.updateViewParams).mockReset();
      vi.mocked(appState.navigation.revalidate).mockReset();
      store.dispose(); machineRegistry.forgetMachine(deviceId);
    }
  });
});

// #581 实机复现:同一个库换了设备 id(换 tier / 重新登记),旧设备行的账号副本里写着这台电脑的项目 id ——
// 它被记到那台名下:本机项目被错路由到那台(「Can't reach …」),那台一被移除,本机项目就从侧栏消失,而本机库里还在。
describe('#581 这台电脑的项目不被别的机器认领', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventOn.mockReturnValue(vi.fn());
  });

  it('别的机器的清单先到、带着本机项目的 id:本机清单到了以本机为准,那台被移除后它还在', async () => {
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const mineRecord = folderRecord({ id: 'keep-me-remote-first' });
    const mine = folderAsProject(mineRecord);
    const store = new ProjectManagerStore();
    vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    store.syncMachineProjects('stale-row-1', [mine]);
    expect(machineRegistry.machineOf(mine.id)).toBe('stale-row-1');

    mocks.listAllFolders.mockResolvedValueOnce([mineRecord]);
    await store.load();
    expect(machineRegistry.machineOf(mine.id)).toBeNull();
    expect(store.projects.get(mine.id)?.data).toEqual(mine);

    store.syncMachineProjects('stale-row-1', [{ ...mine, kind: 'workspace' }]);
    expect(machineRegistry.machineOf(mine.id), '再登记也认领不走').toBeNull();
    expect(store.projects.get(mine.id)?.data?.kind, '远端类别不能改写本机项目').toBeUndefined();
    store.dropMachine('stale-row-1');
    machineRegistry.forgetMachine('stale-row-1');
    expect(store.projects.has(mine.id)).toBe(true);
  });

  it('同一台 server 两条设备行:旧行的账号副本抢不走活的那台答过的项目,也不因它的清单变了拿掉', async () => {
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const theirs = localProject({ id: 'server-project-two-rows', name: 'srv' });
    const store = new ProjectManagerStore();
    vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    store.syncMachineProjects('live-row', [theirs]);
    store.syncMachineProjects('stale-row', [theirs], [], 'account');
    expect(machineRegistry.machineOf(theirs.id)).toBe('live-row');
    store.syncMachineProjects('stale-row', [], [], 'account');
    expect(store.projects.has(theirs.id), '旧行的清单空了,活的那台的项目还在').toBe(true);
    store.dropMachine('stale-row'); store.dropMachine('live-row');
    machineRegistry.forgetMachine('stale-row'); machineRegistry.forgetMachine('live-row');
  });

  it('本机清单先到:别的机器的清单(账号副本)再写着它也认领不走,那台的清单变了 / 被移除都拿不掉它', async () => {
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const mineRecord = folderRecord({ id: 'keep-me-local-first' });
    const mine = folderAsProject(mineRecord);
    const store = new ProjectManagerStore();
    vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    mocks.listAllFolders.mockResolvedValueOnce([mineRecord]);
    await store.load();

    store.syncMachineProjects('stale-row-2', [mine]);
    expect(machineRegistry.machineOf(mine.id)).toBeNull();
    store.syncMachineProjects('stale-row-2', []);
    store.dropMachine('stale-row-2');
    machineRegistry.forgetMachine('stale-row-2');
    expect(store.projects.has(mine.id)).toBe(true);
  });

  it('别的机器的应答 / 推送里带着本机项目的 id(absorb):认领不走', async () => {
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const mine = folderRecord({ id: 'keep-me-absorbed' });
    const store = new ProjectManagerStore();
    vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    mocks.listAllFolders.mockResolvedValueOnce([mine]);
    await store.load();
    machineRegistry.absorb('peer-3', { sessions: [{ id: 'remote-child', projectId: 'their-project' }, { parent: { projectId: mine.id } }] });
    expect(machineRegistry.machineOf('their-project')).toBe('peer-3');
    expect(machineRegistry.machineOf(mine.id)).toBeNull();
    machineRegistry.forgetMachine('peer-3');
  });
});

describe('ensureMounted:挂载的唯一入口(别的机器上的项目列出不挂,用到才挂)', () => {
  it('那台机器的项目:登记时不挂;要用时线没开就等它开了再挂,同一个项目只等一份', async () => {
    const { machineRegistry } = await import('@renderer/lib/machine-routing');
    const store = new ProjectManagerStore();
    store.syncMachineProjects('dev-r', [localProject({ id: 'remote-p' })]);
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    expect(machineRegistry.machineOf('remote-p')).toBe('dev-r');
    expect(mount).not.toHaveBeenCalled();

    const first = store.ensureMounted('remote-p');
    const second = store.ensureMounted('remote-p');
    expect(second).toBe(first);
    setLink('dev-r', 'connecting');
    expect(mount).not.toHaveBeenCalled();
    setLink('dev-r', 'open');
    await first;
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledWith('remote-p');

    // 线开着:当场挂
    await store.ensureMounted('remote-p');
    expect(mount).toHaveBeenCalledTimes(2);
    machineRegistry.forgetMachine('dev-r');
  });

  it('本机项目:直接挂', async () => {
    const store = new ProjectManagerStore();
    const mount = vi.spyOn(store, 'mountProject').mockResolvedValue(undefined);
    await store.ensureMounted('local-p');
    expect(mount).toHaveBeenCalledWith('local-p');
  });
});
