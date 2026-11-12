import { observable, runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { IMPLICIT_SESSION_HOME_PROJECT_ID } from '@renderer/features/sessions/session-home-project-constants';
import { SidebarStore } from './sidebar-store';
import { THIS_COMPUTER, sidebarOf } from './mirror-account-projects.testing';
import { AccountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import type { AccountProject } from '@gugu/core/cloud/deviceProjects';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@renderer/lib/ipc', () => {
  const ipc = {
  events: {
    on: vi.fn(),
  },
  rpc: {},
};
  // 本机(null)那条线就是 events.on;测试里的项目都在本机。
  return { ...ipc, onMachineEvent: (_machine: unknown, event: never, cb: never) => (ipc.events.on as (...args: unknown[]) => () => void)(event, cb) };
});

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {},
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    rowSessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

function projectManager(
  projects: { id: string; createdAt: string; name?: string }[]
): SidebarProjectManager {
  return {
    projects: new Map(projects.map((p) => [p.id, { ...p, mountedProject: null }])),
  } as unknown as SidebarProjectManager;
}

function sessionFixture(id: string, createdAt: string) {
  return {
    state: 'provisioned',
    data: {
      id,
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function projectManagerWithSessions(
  projects: {
    id: string;
    createdAt: string;
    sessionIds: string[];
  }[]
): SidebarProjectManager {
  return {
    projects: new Map(
      projects.map((project) => [
        project.id,
        {
          id: project.id,
          createdAt: project.createdAt,
          mountedProject: {
            sessionManager: {
              sessions: new Map(
                project.sessionIds.map((sessionId, index) => [
                  sessionId,
                  sessionFixture(sessionId, `2026-01-01T00:00:0${index}.000Z`),
                ])
              ),
            },
          },
        },
      ])
    ),
  } as unknown as SidebarProjectManager;
}

/** The row placement shows a session under: its project row id, null for the Tasks section, undefined = not placed. */
function placedRow(store: SidebarStore, entryId: string): string | null | undefined {
  const node = store.placement.nodeById.get(entryId);
  return node ? store.rowOfSession(node.item.projectId, node.item.sessionId) : undefined;
}

describe('SidebarStore project ordering', () => {
  it('keeps the raw title and creation time for component display without rewriting addressing data', () => {
    const createdAt = '2026-11-02T08:00:00.000Z';
    const page = { ...sessionFixture('fresh', createdAt), data: { ...sessionFixture('fresh', createdAt).data, title: 'Codex 5', providerId: 'codex', runtime: 'acp', lastInteractedAt: createdAt } };
    const manager = { projects: new Map([['project', { id: 'project', createdAt, mountedProject: { sessionManager: { sessions: new Map([['fresh', page]]) } } }]]) } as unknown as SidebarProjectManager;
    sessionRegistry.acquire('fresh', 'project', [{ ...page.data, projectId: 'project', runtime: 'acp', agentStatus: null }]);
    try {
      const store = sidebarOf(manager);
      expect(store.placement.entries.get('project')).toEqual([expect.objectContaining({ title: 'Codex 5', createdAt })]);
    } finally { sessionRegistry.release('fresh'); }
  });
  it('counts a projectless child once when its workspace is also folded into a project group (#574)', () => {
    const home = IMPLICIT_SESSION_HOME_PROJECT_ID;
    const row = 'hydration-project';
    const parent = 'hydration-parent';
    const child = 'hydration-child';
    sessionRegistry.acquire(parent, row, [{
      id: parent, projectId: row, providerId: 'codex', title: 'Parent', runtime: 'pty',
      lastInteractedAt: '2026-01-01T00:00:02.000Z', agentStatus: null,
    }]);
    sessionRegistry.acquire(child, home, [{
      id: child, projectId: home, providerId: 'codex', title: 'Child', runtime: 'pty',
      lastInteractedAt: '2026-01-01T00:00:01.000Z', agentStatus: 'needs_user', parentSessionId: parent,
    }]);
    const store = sidebarOf(projectManagerWithSessions([
      // 同一个项目:行落在最早建的那个上(groupRowOrder)。
      { id: row, createdAt: '2025-12-31T00:00:00.000Z', sessionIds: [parent] },
      { id: home, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: [child] },
    ]), () => 'shared-project-chat');
    store.machines = { machineOf: () => null, label: () => null, homeDir: () => null };
    try {
      // Both page registries are unique. The aggregation reads the child through
      // the folded project and again through standaloneOwnEntries().
      expect(store.projectMembersOf(row)).toEqual([row, home]);
      expect(sessionRegistry.get(child)?.sessions.size).toBe(1);
      expect(store.placement.entries.get(row)?.map((entry) => entry.id)).toEqual([parent, child]);
      expect(placedRow(store, child)).toBe(row);
    } finally {
      sessionRegistry.release(parent);
      sessionRegistry.release(child);
    }
  });

  it('persists and restores expanded conversation rows', () => {
    const source = sidebarOf(projectManager([]));
    source.toggleSessionExpanded('parent-conversation');

    const restored = sidebarOf(projectManager([]));
    restored.restoreSnapshot(source.snapshot);

    expect([...restored.expandedSessionIds]).toEqual(['parent-conversation']);
  });

  it('keeps a restored collapsed project collapsed when its tasks load', () => {
    const sessions = observable.map<string, ReturnType<typeof sessionFixture>>();
    const store = sidebarOf({
      projects: new Map([
        [
          'project-1',
          {
            id: 'project-1',
            createdAt: '2026-01-01T00:00:00.000Z',
            mountedProject: { sessionManager: { sessions } },
          },
        ],
      ]),
    } as unknown as SidebarProjectManager);
    store.restoreSnapshot({ expandedProjectIds: [] });

    runInAction(() => sessions.set('task-1', sessionFixture('task-1', '2026-01-01T00:00:00.000Z')));

    expect(store.expandedProjectIds.has('project-1')).toBe(false);
  });

  it('sorts projects newest first by default', () => {
    const store = sidebarOf(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'old']);
  });

  it('places projects missing from a saved manual order first', () => {
    const store = sidebarOf(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'manual', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    store.restoreSnapshot({ projectOrder: ['manual', 'old'] });

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'manual', 'old']);
  });

  it('hides the app-owned project that backs projectless tasks', () => {
    const store = sidebarOf(
      projectManager([
        {
          id: IMPLICIT_SESSION_HOME_PROJECT_ID,
          name: '任务工作区',
          createdAt: '2026-01-03T00:00:00.000Z',
        },
        { id: 'same-name', name: '任务工作区', createdAt: '2026-01-04T00:00:00.000Z' },
        { id: 'visible', name: 'Visible', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['same-name', 'visible']);
    expect(store.isEmpty).toBe(false);

    const hiddenOnly = sidebarOf(
      projectManager([
        {
          id: IMPLICIT_SESSION_HOME_PROJECT_ID,
          name: '任务工作区',
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ])
    );
    expect(hiddenOnly.orderedProjects).toEqual([]);
    expect(hiddenOnly.isEmpty).toBe(true);
  });

  // 侧栏拖一条会话到另一条上 = 挂到它下面:落点只给挂得上的行 —— 已经挂在这里的、它自己的子孙(成环)不给。
  it('answers who a session hangs under and whether a row sits in its subtree', () => {
    const row = (id: string, parentSessionId?: string) => ({
      id,
      projectId: 'project-1',
      providerId: 'codex',
      title: id,
      lastInteractedAt: '2026-01-01T00:00:01.000Z',
      runtime: 'acp' as const,
      ...(parentSessionId ? { parentSessionId } : {}),
    });
    sessionRegistry.acquire('top', 'project-1', [row('top')]);
    sessionRegistry.acquire('mid', 'project-1', [row('mid', 'top')]);
    sessionRegistry.acquire('leaf', 'project-1', [row('leaf', 'mid')]);
    sessionRegistry.acquire('other', 'project-1', [row('other')]);
    const store = sidebarOf(
      projectManagerWithSessions([
        { id: 'project-1', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['top', 'mid', 'leaf', 'other'] },
      ])
    );

    expect(store.parentOf('leaf')).toBe('mid');
    expect(store.parentOf('top')).toBeNull();
    expect(store.parentOf('missing')).toBeNull();
    // `top` 往 `leaf` 下面挂:leaf 在 top 的子树里 ⇒ 成环,不给落点。
    expect(store.isWithin('leaf', 'top')).toBe(true);
    expect(store.isWithin('top', 'top')).toBe(true);
    // 反过来、旁支都挂得上。
    expect(store.isWithin('top', 'leaf')).toBe(false);
    expect(store.isWithin('other', 'top')).toBe(false);

    for (const id of ['top', 'mid', 'leaf', 'other']) sessionRegistry.release(id);
  });

  it('shows a nested session under the row of the session it hangs under', () => {
    const row = (id: string, projectId: string, parentSessionId?: string) => ({
      id,
      projectId,
      providerId: 'codex',
      title: id,
      lastInteractedAt: '2026-01-01T00:00:01.000Z',
      runtime: 'acp' as const,
      ...(parentSessionId ? { parentSessionId } : {}),
    });
    sessionRegistry.acquire('standalone-parent', IMPLICIT_SESSION_HOME_PROJECT_ID, [row('standalone-parent', IMPLICIT_SESSION_HOME_PROJECT_ID)]);
    sessionRegistry.acquire('project-child', 'project-1', [row('project-child', 'project-1', 'standalone-parent')]);
    const store = sidebarOf(
      projectManagerWithSessions([
        { id: IMPLICIT_SESSION_HOME_PROJECT_ID, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['standalone-parent'] },
        { id: 'project-1', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['project-child'] },
      ])
    );

    // child 跟着父会话显示在「任务」分区里,❌ 留在自己的项目行。
    expect(store.rowOfSession('project-1', 'project-child')).toBeNull();

    for (const id of ['standalone-parent', 'project-child']) sessionRegistry.release(id);
  });

  it('lists a session of the implicit home project in the Tasks section', () => {
    sessionRegistry.acquire('legacy-task', IMPLICIT_SESSION_HOME_PROJECT_ID, [
      {
        id: 'legacy-conv',
        projectId: IMPLICIT_SESSION_HOME_PROJECT_ID,
        providerId: 'claude',
        title: '老行',
        lastInteractedAt: '2026-01-01T00:00:05.000Z',
        runtime: 'pty',
        agentStatus: 'needs_user',
      },
    ]);
    const store = sidebarOf(
      projectManagerWithSessions([
        {
          id: IMPLICIT_SESSION_HOME_PROJECT_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
          sessionIds: ['legacy-task'],
        },
      ])
    );

    expect(placedRow(store, 'legacy-conv')).toBeNull();
  });

  it('#609 a workspace this computer keeps (kind workspace: ~, the assistant\'s directories) is no project row; its sessions are Tasks', () => {
    sessionRegistry.acquire('home-task', 'home-workspace', [
      { id: 'home-conv', projectId: 'home-workspace', providerId: 'claude', title: 'in ~', lastInteractedAt: '2026-01-01T00:00:05.000Z', runtime: 'pty', agentStatus: 'idle' },
    ]);
    const manager = projectManagerWithSessions([
      { id: 'home-workspace', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['home-task'] },
      { id: 'code', createdAt: '2026-01-02T00:00:00.000Z', sessionIds: [] },
    ]);
    (manager.projects.get('home-workspace') as unknown as { data: { kind: string } }).data = { kind: 'workspace' };
    const store = sidebarOf(manager);

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['code']);
    expect(placedRow(store, 'home-conv')).toBeNull();
    sessionRegistry.release('home-task');
  });

  it('excludes the local assistant identity while keeping its delegated task family', () => {
    const home = 'assistant-home';
    const record = (id: string, parentSessionId?: string) => ({
      id, projectId: home, providerId: 'codex', title: id, runtime: 'acp' as const,
      agentStatus: 'idle' as const, parentSessionId, isPinned: id === 'own',
      lastInteractedAt: '2026-01-01T00:00:00.000Z',
    });
    const records = [record('own'), record('executor', 'own'), record('grandchild', 'executor'), record('other')];
    for (const record of records) sessionRegistry.acquire(record.id, home, [record]);
    const identity = vi.spyOn(sessionAgentBindings, 'bindingFor').mockImplementation((id) =>
      id === 'own' ? { agentUserId: 'assistant', displayName: 'renamed assistant' } : undefined);
    try {
      const manager = projectManagerWithSessions([
        { id: home, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: records.map((r) => r.id) },
        { id: 'business', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: [] },
      ]);
      (manager.projects.get(home) as unknown as { data: { kind?: string } }).data = { kind: 'workspace' };
      const store = sidebarOf(manager);
      store.setAssistantAgentId('assistant');
      expect(store.orderedProjects.map((p) => p.id)).toEqual(['business']);
      expect([...store.placement.nodeById.keys()].sort()).toEqual(['executor', 'grandchild', 'other']);
      expect(['executor', 'grandchild', 'other'].map((id) => placedRow(store, id))).toEqual([null, null, null]);
      expect(store.rowOfSession(home, 'executor')).toBeNull();
      // With the project visible again its sessions return to the project, without duplicates.
      (manager.projects.get(home) as unknown as { data: { kind?: string } }).data = {};
      const userProjectStore = sidebarOf(manager);
      userProjectStore.setAssistantAgentId('assistant');
      expect(userProjectStore.orderedProjects.map((p) => p.id)).toContain(home);
      expect(placedRow(userProjectStore, 'executor')).toBe(home);
      expect(manager.projects.size).toBe(2);
    } finally {
      identity.mockRestore();
      for (const record of records) sessionRegistry.release(record.id);
    }
  });

  // #2548 the one list draws my standalone tasks as their agents' conversations; a task whose session has no 咕咕 identity
  // (never driven, an engine that cannot be addressed) has no conversation, so it is a row of its own (oneListTail).
  it('lists the top-level standalone tasks with no agent identity, once this machine\'s identities are read', () => {
    const home = 'tasks-workspace';
    const record = (id: string, lastInteractedAt: string, parentSessionId?: string) => ({
      id, projectId: home, providerId: 'codex', title: id, runtime: 'pty' as const, agentStatus: 'idle' as const,
      parentSessionId, lastInteractedAt,
    });
    const records = [
      record('no-identity-old', '2026-01-01T00:00:01.000Z'),
      record('no-identity-new', '2026-01-01T00:00:03.000Z'),
      record('with-identity', '2026-01-01T00:00:02.000Z'),
      record('fork-no-identity', '2026-01-01T00:00:04.000Z', 'with-identity'),
    ];
    for (const record of records) sessionRegistry.acquire(record.id, home, [record]);
    const identity = vi.spyOn(sessionAgentBindings, 'bindingFor').mockImplementation((id) =>
      id === 'with-identity' ? { agentUserId: 'agent-1' } : undefined);
    try {
      const manager = projectManagerWithSessions([
        { id: home, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: records.map((r) => r.id) },
      ]);
      (manager.projects.get(home) as unknown as { data: { kind?: string } }).data = { kind: 'workspace' };
      const store = sidebarOf(manager);
      runInAction(() => { sessionAgentBindings.isLoaded = false; });
      expect(store.tasksWithoutAgent, 'not known yet: none rather than a row that is about to move').toEqual([]);
      runInAction(() => { sessionAgentBindings.isLoaded = true; });
      expect(store.tasksWithoutAgent).toEqual([
        { projectId: home, sessionId: 'no-identity-new' },
        { projectId: home, sessionId: 'no-identity-old' },
      ]);
    } finally {
      runInAction(() => { sessionAgentBindings.isLoaded = false; });
      identity.mockRestore();
      for (const record of records) sessionRegistry.release(record.id);
    }
  });

});

// #6264 behavior gugu-server「会话页里的别的机器」(owner 2026-09-25 选 A):别的机器上的会话一律属于那台机器上的
// 某个项目;没选项目的挂在那台机器的主目录项目「~」下(读取时归属);「任务」列表只放本机没有项目的会话。
describe('SidebarStore: 别的机器上的会话归到那台机器的项目下', () => {
  const REMOTE_SESSION_HOME = `${IMPLICIT_SESSION_HOME_PROJECT_ID}~d22`;
  /** d22 上的会话:来自会话目录(列出不挂载),❌ 来自挂载的项目。 */
  const listed = new Map<string, SessionpageSessionSummary>();
  const machineOf = (id: string) => (id === REMOTE_SESSION_HOME || id.startsWith('d22-') ? 'd22' : null);
  const machines = {
    machineOf,
    label: () => 'd22',
    homeDir: () => '/root',
    sessionsOf: () => ({ sessions: [...listed.values()], live: true }),
    session: (_deviceId: string, id: string) => listed.get(id) ?? null,
  };
  beforeEach(() => listed.clear());

  function managerWithPaths(
    projects: { id: string; path: string; sessionIds: string[]; name?: string; kind?: 'workspace' }[]
  ): SidebarProjectManager {
    return {
      projects: new Map(
        projects.map((project) => [
          project.id,
          {
            id: project.id,
            name: project.name ?? null,
            createdAt: '2026-01-01T00:00:00.000Z',
            data: { path: project.path, kind: project.kind },
            mountedProject: {
              sessionManager: {
                sessions: new Map(
                  project.sessionIds.map((sessionId) => [
                    sessionId,
                    sessionFixture(sessionId, '2026-01-01T00:00:00.000Z'),
                  ])
                ),
              },
            },
          },
        ])
      ),
    } as unknown as SidebarProjectManager;
  }

  function acquire(sessionId: string, projectId: string, rowSessionId: string, parentSessionId?: string) {
    if (machineOf(projectId)) {
      listed.set(rowSessionId, {
        conversationId: rowSessionId,
        projectId,
        title: rowSessionId,
        harness: 'codex',
        runtime: 'acp',
        agentStatus: null,
        lastInteractedAt: '2026-01-02T00:00:00.000Z',
        supported: true,
        parentConversationId: parentSessionId ?? null,
      });
    }
    sessionRegistry.acquire(sessionId, projectId, [
      {
        id: rowSessionId,
        projectId,
        providerId: 'codex',
        title: rowSessionId,
        lastInteractedAt: '2026-01-02T00:00:00.000Z',
        type: 'acp',
        parentSessionId,
      },
    ] as never);
  }

  it('#609 那台机器的任务工作区、迁成 workspace 的主目录项目都不单列,会话与本机的一起平铺在「任务」里', () => {
    acquire('rt-old', REMOTE_SESSION_HOME, 'rc-old');
    acquire('rt-home', 'd22-home', 'rc-home');
    acquire('lt-mine', IMPLICIT_SESSION_HOME_PROJECT_ID, 'lc-mine');
    const store = sidebarOf(
      managerWithPaths([
        { id: 'd22-home', path: '/root', sessionIds: ['rt-home'], kind: 'workspace' },
        { id: REMOTE_SESSION_HOME, path: '/root/.config/咕咕/task-home', sessionIds: ['rt-old'] },
        { id: IMPLICIT_SESSION_HOME_PROJECT_ID, path: '/me/task-home', sessionIds: ['lt-mine'] },
      ])
    );
    store.machines = machines;

    expect(store.orderedProjects).toEqual([]);
    expect([...store.placement.nodeById.keys()].sort()).toEqual(['lc-mine', 'rc-home', 'rc-old']);
    expect(['lc-mine', 'rc-home', 'rc-old'].map((id) => placedRow(store, id))).toEqual([null, null, null]);
    expect(store.rowOfSession(REMOTE_SESSION_HOME, 'rc-old')).toBeNull();
    expect(store.rowOfSession('d22-home', 'rc-home')).toBeNull();
    expect(store.projectLabel(REMOTE_SESSION_HOME)).toBeNull();
    // 对照:没迁过的老 server 上,主目录项目还是 kind=project —— 就是一个普通项目行(❌「~」)。
    const legacy = sidebarOf(managerWithPaths([{ id: 'd22-home', path: '/root', sessionIds: ['rt-home'], name: 'root' }]));
    legacy.machines = machines;
    expect(legacy.orderedProjects.map((p) => p.id)).toEqual(['d22-home']);
    expect(legacy.projectLabel('d22-home')).toBe('root');
    for (const id of ['rt-old', 'rt-home', 'lt-mine']) sessionRegistry.release(id);
  });

  it.each([true, false])('keeps assistant-host workspaces out of Projects while retaining tasks (live=%s)', (live) => {
    acquire('rt-assistant', 'd22-home', 'rc-assistant');
    acquire('rt-executor', 'd22-home', 'rc-executor', 'rc-assistant');
    acquire('rt-grandchild', REMOTE_SESSION_HOME, 'rc-grandchild', 'rc-executor');
    acquire('rt-business', 'd22-business', 'rc-business');
    listed.set('rc-assistant', { ...listed.get('rc-assistant')!, agent: { userId: 'assistant-id' }, title: 'Renamed assistant', isPinned: true, lastInteractedAt: '2026-11-05T13:00:31.418Z' });
    listed.set('rc-executor', { ...listed.get('rc-executor')!, status: { status: 'needs_user', detail: null } });
    const store = sidebarOf(managerWithPaths([
      { id: 'd22-home', path: '/root', name: 'Internal home', kind: 'workspace', sessionIds: ['rt-assistant', 'rt-executor'] },
      { id: REMOTE_SESSION_HOME, path: '/root/.config/app/task-home', sessionIds: ['rt-grandchild'] },
      { id: 'd22-business', path: '/root/business', name: 'Business', sessionIds: ['rt-business'] },
      { id: 'local-business', path: '/me/business', name: '咕咕', sessionIds: [] },
    ]));
    store.machines = { ...machines, isAssistantHome: () => true, label: () => 'Renamed assistant',
      sessionsOf: () => ({ sessions: [...listed.values()], live }) };
    store.setAssistantAgentId('assistant-id');
    try {
      expect(store.orderedProjects.map((p) => p.id).sort()).toEqual(['d22-business', 'local-business']);
      expect(store.projectLabel('d22-home')).toBeNull();
      expect(store.projectLabel('d22-business')).toBe('Business');
      expect(store.placement.nodeById.has('rc-assistant')).toBe(false);
      expect(['rc-executor', 'rc-grandchild'].map((id) => placedRow(store, id))).toEqual([null, null]);
      expect(store.rowOfSession('d22-home', 'rc-executor')).toBeNull();
      expect(store.placement.nodeById.get('rc-executor')?.item.group).toBe('needs-you');
      expect(store.placement.entries.get('d22-business')?.map((e) => e.id)).toEqual(['rc-business']);
    } finally {
      for (const id of ['rt-assistant', 'rt-executor', 'rt-grandchild', 'rt-business']) sessionRegistry.release(id);
    }
  });

  // #7341 第二步:同一个项目在本机与 d22 上各有一个本地项目,绑在同一个项目群上 ⇒ 侧栏合成一行。
  it('绑在同一个项目群上的本机项目与 d22 上的项目合成一行,d22 那边的会话挂在这一行下', () => {
    acquire('lt-g', 'local-gugu', 'lc-g');
    acquire('rt-g', 'd22-gugu', 'rc-g');
    const manager = () =>
      managerWithPaths([
        { id: 'local-gugu', path: '/Users/me/gugu', sessionIds: ['lt-g'], name: 'gugu' },
        { id: 'd22-gugu', path: '/www/gugu', sessionIds: ['rt-g'], name: 'gugu' },
      ]);
    const store = sidebarOf(manager(), (id: string) => (id.endsWith('-gugu') ? 'chat-gugu' : undefined));
    store.machines = machines;
    store.sidebarProjects.forEach((project) => store.ensureProjectExpanded(project.id));

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['local-gugu']);
    expect(store.rowProjectIdOf('d22-gugu')).toBe('local-gugu');
    expect(store.projectMembersOf('local-gugu')).toEqual(['local-gugu', 'd22-gugu']);
    expect(store.placement.entries.get('local-gugu')?.map((e) => e.id).sort()).toEqual(['lc-g', 'rc-g']);

    // 对照:不知道绑定(或没绑)时,两台上的各是一行。
    const separate = sidebarOf(manager());
    separate.machines = machines;
    expect(separate.orderedProjects.map((p) => p.id).sort()).toEqual(['d22-gugu', 'local-gugu']);
    sessionRegistry.release('lt-g');
    sessionRegistry.release('rt-g');
  });

  // 项目与机器解耦:「项目」分区只列账号上的项目(accountProjectsStore),归属只读它的绑定。
  describe('rows come from the account project store only', () => {
    function accountSidebar(manager: SidebarProjectManager, projects: AccountProject[]) {
      const accounts = new AccountProjectsStore();
      const store = new SidebarStore(manager, accounts);
      accounts.attach({
        projects: manager.projects,
        machineOf: (id) => store.machines?.machineOf(id) ?? null,
        connected: (deviceId) => store.machines?.connected?.(deviceId) === true,
      });
      runInAction(() => {
        accounts.list = projects;
        accounts.localDeviceId = THIS_COMPUTER;
        accounts.status = 'ready';
      });
      store.machines = { ...machines, connected: () => true };
      return { store, accounts };
    }

    it('one row per project with folders on two machines, sessions of both under it, labelled with the project name', () => {
      acquire('at-local', 'local-paper', 'ac-local');
      acquire('at-remote', 'd22-paper', 'ac-remote');
      try {
        const { store } = accountSidebar(managerWithPaths([
          { id: 'local-paper', path: '/me/paper', sessionIds: ['at-local'], name: 'paper-local-folder' },
          { id: 'd22-paper', path: '/root/paper', sessionIds: ['at-remote'], name: 'paper-d22-folder' },
        ]), [{
          chatId: 'chat-paper', name: 'Paper', archived: false, activeAt: '2026-01-01T00:00:00.000Z',
          bindings: [{ deviceId: 'd22', localProjectId: 'd22-paper' }, { deviceId: THIS_COMPUTER, localProjectId: 'local-paper' }],
        }]);
        expect(store.sidebarProjects.map((ref) => [ref.kind, ref.id, ref.chatId, ref.name])).toEqual([['local', 'local-paper', 'chat-paper', 'Paper']]);
        expect(store.projectMembersOf('local-paper')).toEqual(['local-paper', 'd22-paper']);
        expect(store.rowProjectIdOf('d22-paper')).toBe('local-paper');
        expect(store.projectLabel('d22-paper')).toBe('Paper');
        store.ensureProjectExpanded('d22-paper');
        expect(store.placement.entries.get('local-paper')?.map((entry) => entry.id).sort()).toEqual(['ac-local', 'ac-remote']);
        expect(store.rowOfSession('d22-paper', 'ac-remote')).toBe('local-paper');
        expect(['ac-local', 'ac-remote'].map((id) => placedRow(store, id))).toEqual(['local-paper', 'local-paper']);
      } finally {
        sessionRegistry.release('at-local');
        sessionRegistry.release('at-remote');
      }
    });

    it('a project without any local project still gets a row keyed by its group; archived ones do not', () => {
      const { store } = accountSidebar(managerWithPaths([]), [
        { chatId: 'chat-empty', name: 'Empty', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [] },
        { chatId: 'chat-elsewhere', name: 'Elsewhere', archived: false, activeAt: '2026-01-01T00:00:00.000Z', bindings: [{ deviceId: 'not-loaded', localProjectId: 'p9' }] },
        { chatId: 'chat-old', name: 'Old', archived: true, activeAt: '2026-01-01T00:00:00.000Z', bindings: [] },
      ]);
      expect(store.sidebarProjects.map((ref) => [ref.kind, ref.id, ref.name])).toEqual([
        ['group', 'chat-elsewhere', 'Elsewhere'],
        ['group', 'chat-empty', 'Empty'],
      ]);
      expect(store.placement.entries.size).toBe(0);
      expect(store.orderedProjects).toEqual([]);
    });

    it('a local project absent from the store is not a row; its sessions are listed under Tasks unless the first read is still under way', () => {
      acquire('at-stray', 'local-stray', 'ac-stray');
      try {
        const { store, accounts } = accountSidebar(managerWithPaths([
          { id: 'local-stray', path: '/me/stray', sessionIds: ['at-stray'], name: 'stray' },
        ]), []);
        expect(store.sidebarProjects).toEqual([]);
        expect(placedRow(store, 'ac-stray')).toBeNull();
        // The read failed: still no project row derived from the local table, and its sessions stay listed (under Tasks).
        runInAction(() => { accounts.status = 'error'; });
        expect(store.sidebarProjects).toEqual([]);
        expect(placedRow(store, 'ac-stray')).toBeNull();
        // The first read, with no list in hand yet: nothing can be matched, so only workspaces are listed meanwhile.
        runInAction(() => { accounts.status = 'loading'; });
        expect(placedRow(store, 'ac-stray')).toBeUndefined();
      } finally {
        sessionRegistry.release('at-stray');
      }
    });
  });

  it('recognizes the provisioned assistant after moving it, without hiding delegated tasks', () => {
    acquire('rt-asst', REMOTE_SESSION_HOME, 'rc-asst');
    acquire('rt-kid', REMOTE_SESSION_HOME, 'rc-kid', 'rc-asst');
    acquire('rt-other', REMOTE_SESSION_HOME, 'rc-other');
    listed.set('rc-asst', { ...listed.get('rc-asst')!, agent: { userId: 'u-asst' } });
    listed.set('rc-kid', { ...listed.get('rc-kid')!, agent: { userId: 'u-kid' } });
    const store = sidebarOf(
      managerWithPaths([{ id: REMOTE_SESSION_HOME, path: '/root/.config/咕咕/task-home', sessionIds: ['rt-asst', 'rt-kid', 'rt-other'] }])
    );
    store.machines = machines;
    const shown = () => [...store.placement.nodeById.keys()].sort();

    // 对照:还不知道助理是谁时,它那条在、子 agent 挂在它下面。
    expect(shown()).toEqual(['rc-asst', 'rc-kid', 'rc-other']);
    expect(store.parentOf('rc-kid')).toBe('rc-asst');
    expect(store.launchedByAssistant(REMOTE_SESSION_HOME, 'rc-kid')).toBe(false);

    store.setAssistantAgentId('u-asst');
    expect(shown()).toEqual(['rc-kid', 'rc-other']);
    expect(store.remoteSession(REMOTE_SESSION_HOME, 'rc-asst')).toBeNull();
    expect(store.launchedByAssistant(REMOTE_SESSION_HOME, 'rc-kid')).toBe(true);
    expect(store.launchedByAssistant(REMOTE_SESSION_HOME, 'rc-other')).toBe(false);
    // Only the canonical identity is hidden; a matching title or project is insufficient.
    store.setAssistantAgentId('u-kid');
    expect(shown()).toEqual(['rc-asst', 'rc-other']);
    for (const id of ['rt-asst', 'rt-kid', 'rt-other']) sessionRegistry.release(id);
  });

  // owner 2026-10-01:别的机器上的 agent 也挂在本机的 agent 下面(反过来也一样),会话列表按「谁派的谁」成组,
  // 行首的机器标记由 parentProjectId 判(父会话与它不在同一台机器上才画)。
  it('跨机器的 child 跟着父会话那一行走,❌ 留在自己机器的项目下', () => {
    acquire('lt-parent', IMPLICIT_SESSION_HOME_PROJECT_ID, 'lc-parent');
    acquire('rt-child', 'd22-app', 'rc-child', 'lc-parent');
    acquire('rt-root', 'd22-app', 'rc-root');
    acquire('lt-kid', 'local-proj', 'lc-kid', 'rc-root');
    const store = sidebarOf(
      managerWithPaths([
        { id: IMPLICIT_SESSION_HOME_PROJECT_ID, path: '/me/task-home', sessionIds: ['lt-parent'] },
        { id: 'd22-app', path: '/root/app', sessionIds: ['rt-child', 'rt-root'] },
        { id: 'local-proj', path: '/me/proj', sessionIds: ['lt-kid'] },
      ])
    );
    store.machines = machines;

    // 本机「任务」分区里的父会话下面挂着 d22 上的 child。
    expect(['lc-parent', 'rc-child'].map((id) => placedRow(store, id))).toEqual([null, null]);
    expect(store.parentOf('rc-child')).toBe('lc-parent');
    // d22 的项目下:它自己的根会话,下面挂着本机的 child;d22 上那个 child 不在这里重复出现,本机项目下也没有行。
    expect(store.placement.entries.get('d22-app')?.map((e) => e.id).sort()).toEqual(['lc-kid', 'rc-root']);
    expect(store.placement.entries.get('local-proj')).toBeUndefined();
    // 键盘 ← 与打开任务时展开的都是它显示在下面的那一行。
    expect(store.rowOfSession('d22-app', 'rc-child')).toBeNull();
    expect(store.rowOfSession('local-proj', 'lt-kid')).toBe('d22-app');
    for (const sessionId of ['lt-parent', 'rt-child', 'rt-root', 'lt-kid']) sessionRegistry.release(sessionId);
  });

  // owner 2026-10-02:本机选了 nest 的 child 也可以在别的项目里 —— 与跨机器同一条:跟着父会话那一行走,行上标它的项目。
  it('本机别的项目里的 child 跟着父会话那一行走,与父会话不在同一个项目行就标项目', () => {
    acquire('pa', 'proj-a', 'c-parent');
    acquire('pb', 'proj-b', 'c-child', 'c-parent');
    acquire('pa2', 'proj-a', 'c-sibling', 'c-parent');
    acquire('rt-home', REMOTE_SESSION_HOME, 'rc-home', 'c-parent');
    const store = sidebarOf(
      managerWithPaths([
        { id: 'proj-a', path: '/me/a', sessionIds: ['pa', 'pa2'], name: 'Alpha' },
        { id: 'proj-b', path: '/me/b', sessionIds: ['pb'], name: 'Beta' },
        { id: REMOTE_SESSION_HOME, path: '/root/.config/咕咕/task-home', sessionIds: ['rt-home'] },
      ])
    );
    store.machines = machines;

    expect(store.placement.entries.get('proj-a')?.map((e) => e.id).sort()).toEqual(['c-child', 'c-parent', 'c-sibling', 'rc-home']);
    expect(store.rowOfSession('proj-b', 'pb')).toBe('proj-a');
    expect(store.nestedProjectLabel('proj-b', 'proj-a')).toBe('Beta');
    expect(store.nestedProjectLabel('proj-a', 'proj-a')).toBeNull();
    // #609 别的机器、没选项目(那台机器的任务工作区):不是项目,只标机器、❌ 标项目名。
    expect(store.nestedProjectLabel(REMOTE_SESSION_HOME, 'proj-a')).toBeNull();
    // 机器标记悬停里写的项目名:不论跟父会话比,都是它自己那一行的名字。
    expect(store.projectLabel('proj-a')).toBe('Alpha');
    expect(store.projectLabel(REMOTE_SESSION_HOME)).toBeNull();
    for (const sessionId of ['pa', 'pb', 'pa2', 'rt-home']) sessionRegistry.release(sessionId);
  });

  it('那台机器上别处建的 standalone 任务(手机 / 远端建 agent)挂在它自己的项目下', () => {
    acquire('rt-app', 'd22-app', 'rc-app');
    const store = sidebarOf(
      managerWithPaths([{ id: 'd22-app', path: '/root/app', sessionIds: ['rt-app'] }])
    );
    store.machines = machines;

    expect(placedRow(store, 'rc-app')).toBe('d22-app');
    sessionRegistry.release('rt-app');
  });

  it('列出不挂载:没挂上的那台机器的项目照样列出会话目录里的会话(打开就先画上次的样子)', () => {
    acquire('rt-listed', 'd22-app', 'rc-listed');
    sessionRegistry.release('rt-listed');
    const store = sidebarOf({
      projects: new Map([
        ['d22-app', { id: 'd22-app', name: 'app', createdAt: '2026-01-01T00:00:00.000Z', data: { path: '/root/app' }, mountedProject: undefined }],
      ]),
    } as unknown as SidebarProjectManager);
    store.machines = machines;
    expect(store.placement.entries.get('d22-app')).toEqual([
      expect.objectContaining({ sessionId: 'rc-listed', projectId: 'd22-app' }),
    ]);
    expect(store.remoteSession('d22-app', 'rc-listed')).toMatchObject({ summary: { conversationId: 'rc-listed' }, live: true });
    expect(store.remoteSession('d22-app', 'nope')).toBeNull();
    expect(store.remoteSession('local-proj', 'rc-listed')).toBeNull();
  });

  it('不是此刻的读数(底稿 / 离线):行上「在跑」不算数;在等你照报;置顶照样记着', () => {
    for (const id of ['busy', 'ask', 'pin']) {
      acquire(`rt-${id}`, 'd22-app', `rc-${id}`);
      sessionRegistry.release(`rt-${id}`);
    }
    listed.set('rc-busy', { ...listed.get('rc-busy')!, status: { status: 'working', detail: null } });
    listed.set('rc-ask', { ...listed.get('rc-ask')!, status: { status: 'needs_user', detail: null } });
    listed.set('rc-pin', { ...listed.get('rc-pin')!, isPinned: true });
    let live = true;
    const store = sidebarOf(managerWithPaths([{ id: 'd22-app', path: '/root/app', sessionIds: [] }]));
    store.machines = { ...machines, sessionsOf: () => ({ sessions: [...listed.values()], live }) };
    const groups = () => {
      const counts: Record<string, number> = {};
      for (const entry of store.placement.entries.get('d22-app') ?? []) if (entry.group) counts[entry.group] = (counts[entry.group] ?? 0) + 1;
      return counts;
    };
    expect(groups()).toEqual({ 'needs-you': 1, working: 1 });
    expect(store.placement.nodeById.get('rc-pin')?.item.isPinned).toBe(true);
    runInAction(() => (live = false));
    store.machines = { ...machines, sessionsOf: () => ({ sessions: [...listed.values()], live }) };
    expect(groups()).toEqual({ 'needs-you': 1 });
  });

  it('本机不变:本机没项目的会话仍在「任务」列表,本机任务工作区不进「项目」', () => {
    acquire('lt-home', IMPLICIT_SESSION_HOME_PROJECT_ID, 'lc-home');
    const store = sidebarOf(
      managerWithPaths([
        { id: IMPLICIT_SESSION_HOME_PROJECT_ID, path: '/Users/me/task-home', sessionIds: ['lt-home'] },
        { id: 'mine', path: '/Users/me', sessionIds: [] },
      ])
    );
    store.machines = machines;

    expect(store.orderedProjects.map((p) => p.id)).toEqual(['mine']);
    expect(placedRow(store, 'lc-home')).toBeNull();
    sessionRegistry.release('lt-home');
  });
});

// Only explicit disclosure controls change persisted project, session and section choices.
describe('SidebarStore keeps what the user folded folded', () => {
  function session(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      projectId: 'project-a',
      providerId: 'codex',
      title: id,
      lastInteractedAt: '2026-01-01T00:00:00.000Z',
      runtime: 'acp',
      ...extra,
    };
  }

  function twoProjects() {
    return sidebarOf(
      projectManagerWithSessions([
        { id: 'project-a', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['task-a1', 'task-a2'] },
        { id: 'project-b', createdAt: '2026-01-02T00:00:00.000Z', sessionIds: ['task-b1'] },
      ])
    );
  }

  it('persists manual project, conversation and overflow choices across a restart', () => {
    const source = twoProjects();
    source.ensureProjectExpanded('project-a');
    source.toggleSessionExpanded('expanded-parent');
    source.toggleSessionExpanded('collapsed-parent');
    source.toggleSessionExpanded('collapsed-parent');
    source.toggleIdleExpanded('project-a');
    const saved = structuredClone(source.snapshot);
    const restored = twoProjects();
    restored.restoreSnapshot(saved);
    expect([...restored.expandedProjectIds]).toEqual(['project-a']);
    expect([...restored.expandedSessionIds]).toEqual(['expanded-parent']);
    expect([...restored.idleExpandedProjectIds]).toEqual(['project-a']);
    expect(restored.expandedProjectIds.has('project-b')).toBe(false);
    expect(restored.expandedSessionIds.has('collapsed-parent')).toBe(false);
  });

  it('does not open a parent or project when new descendants or activity arrive', () => {
    const page = 'task-manual';
    const manager = projectManagerWithSessions([
      { id: 'project-a', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: [page] },
    ]);
    const store = sidebarOf(manager);
    const parent = session('manual-parent');
    try {
      sessionRegistry.acquire(page, 'project-a', [parent] as never);
      store.ensureProjectExpanded('project-a');
      store.toggleSessionExpanded(parent.id);
      store.collapseProject('project-a');
      store.toggleSessionExpanded(parent.id);
      const saved = structuredClone(store.snapshot);
      for (const status of ['working', 'needs_user', null]) {
        sessionRegistry.release(page);
        sessionRegistry.acquire(page, 'project-a', [
          { ...parent, agentStatus: status, lastInteractedAt: '2026-11-03T05:00:00.000Z' },
          session('new-child', { parentSessionId: parent.id, agentStatus: status }),
        ] as never);
        expect(store.placement.nodeById.get('new-child')?.item.parentSessionId).toBe(parent.id);
        expect(store.snapshot).toEqual(saved);
      }
    } finally { sessionRegistry.release(page); }
  });

  it('a blob written by the old desktop sidebar (section folds, 项目 | 对话 layout and page) still restores; those fields are ignored (#2548)', () => {
    const restored = twoProjects();
    restored.restoreSnapshot({
      expandedProjectIds: ['project-a'],
      pinnedCollapsed: true,
      projectsCollapsed: true,
      sessionsCollapsed: true,
      chatsCollapsed: true,
      listLayout: 'merged',
      listPage: 'chats',
    } as Parameters<SidebarStore['restoreSnapshot']>[0]);
    expect([...restored.expandedProjectIds]).toEqual(['project-a']);
    expect(Object.keys(restored.snapshot).sort()).toEqual([
      'expandedProjectIds',
      'expandedSessionIds',
      'idleExpandedProjectIds',
      'projectOrder',
      'sessionOrderByProject',
      'sessionSortBy',
    ]);
  });
});
