import { runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { SidebarStore } from './sidebar-store';
import { setSidebarFold, sidebarFolds } from './sidebar-folds';

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
const sidebarOf = (manager: SidebarProjectManager) => new SidebarStore(manager);

/** Every entry the store placed, whatever group (or the Tasks section) it sits in. */
function allEntries(store: SidebarStore) {
  return [...store.placement.entries.values()].flat();
}

describe('SidebarStore placement', () => {
  it('keeps the raw title and creation time for component display without rewriting addressing data', () => {
    const createdAt = '2026-11-02T08:00:00.000Z';
    const page = { ...sessionFixture('fresh', createdAt), data: { ...sessionFixture('fresh', createdAt).data, title: 'Codex 5', providerId: 'codex', runtime: 'acp', lastInteractedAt: createdAt } };
    const manager = { projects: new Map([['project', { id: 'project', createdAt, mountedProject: { sessionManager: { sessions: new Map([['fresh', page]]) } } }]]) } as unknown as SidebarProjectManager;
    sessionRegistry.acquire('fresh', 'project', [{ ...page.data, projectId: 'project', runtime: 'acp', agentStatus: null }]);
    try {
      const store = sidebarOf(manager);
      expect(allEntries(store)).toEqual([expect.objectContaining({ title: 'Codex 5', createdAt })]);
    } finally { sessionRegistry.release('fresh'); }
  });

  it('counts a child in another folder once, under the group of the session it hangs under (#574)', () => {
    const row = 'hydration-project';
    const other = 'other-folder';
    const parent = 'hydration-parent';
    const child = 'hydration-child';
    sessionRegistry.acquire(parent, row, [{
      id: parent, projectId: row, providerId: 'codex', title: 'Parent', runtime: 'pty',
      lastInteractedAt: '2026-01-01T00:00:02.000Z', agentStatus: null, groupChatId: 'shared-chat',
    }] as never);
    sessionRegistry.acquire(child, other, [{
      id: child, projectId: other, providerId: 'codex', title: 'Child', runtime: 'pty',
      lastInteractedAt: '2026-01-01T00:00:01.000Z', agentStatus: 'needs_user', parentSessionId: parent,
    }]);
    const store = sidebarOf(projectManagerWithSessions([
      { id: row, createdAt: '2025-12-31T00:00:00.000Z', sessionIds: [parent] },
      { id: other, createdAt: '2026-01-01T00:00:00.000Z', sessionIds: [child] },
    ]));
    store.machines = { machineOf: () => null, label: () => null, homeDir: () => null };
    try {
      expect(sessionRegistry.get(child)?.sessions.size).toBe(1);
      expect(store.placement.entries.get('shared-chat')?.map((entry) => entry.id)).toEqual([parent, child]);
      expect(store.groupOfSession(child)).toBe('shared-chat');
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

  it('shows a nested session where the session it hangs under is, and a session in no group in the Tasks section', () => {
    const row = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({
      id,
      projectId,
      providerId: 'codex',
      title: id,
      lastInteractedAt: '2026-01-01T00:00:01.000Z',
      runtime: 'acp' as const,
      ...extra,
    });
    sessionRegistry.acquire('standalone-parent', 'task-home', [row('standalone-parent', 'task-home')]);
    sessionRegistry.acquire('grouped-child', 'project-1', [row('grouped-child', 'project-1', { parentSessionId: 'standalone-parent', groupChatId: 'chat-1' })] as never);
    sessionRegistry.acquire('grouped', 'project-1', [row('grouped', 'project-1', { groupChatId: 'chat-1' })] as never);
    const store = sidebarOf(
      projectManagerWithSessions([
        { id: 'task-home', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['standalone-parent'] },
        { id: 'project-1', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: ['grouped-child', 'grouped'] },
      ])
    );

    // child 跟着父会话显示在「任务」分区里,❌ 留在自己的群里。
    expect(store.groupOfSession('grouped-child')).toBeNull();
    expect(store.groupOfSession('standalone-parent')).toBeNull();
    expect(store.groupOfSession('grouped')).toBe('chat-1');
    expect(store.groupOfSession('missing')).toBeNull();

    for (const id of ['standalone-parent', 'grouped-child', 'grouped']) sessionRegistry.release(id);
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
      ]);
      const store = sidebarOf(manager);
      store.setAssistantAgentId('assistant');
      expect([...store.placement.nodeById.keys()].sort()).toEqual(['executor', 'grandchild', 'other']);
      expect(['executor', 'grandchild', 'other'].map((id) => store.groupOfSession(id))).toEqual([null, null, null]);
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

// #6264 别的机器上的会话来自那台机器的会话目录(列出不挂载);归在它所在的群(目录行上的 groupChatId),没有群就在「任务」里。
describe('SidebarStore: 别的机器上的会话', () => {
  const REMOTE_TASK_HOME = 'd22-task-home';
  /** d22 上的会话:来自会话目录(列出不挂载),❌ 来自挂载的项目。 */
  const listed = new Map<string, SessionpageSessionSummary>();
  const machineOf = (id: string) => (id.startsWith('d22-') ? 'd22' : null);
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

  function acquire(sessionId: string, projectId: string, rowSessionId: string, parentSessionId?: string, groupChatId?: string) {
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
        groupChatId: groupChatId ?? null,
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
        groupChatId,
      },
    ] as never);
  }

  it('#609 sessions in no group, on that machine and on this one, are listed together in the Tasks section', () => {
    acquire('rt-old', REMOTE_TASK_HOME, 'rc-old');
    acquire('rt-home', 'd22-home', 'rc-home');
    acquire('lt-mine', 'task-home', 'lc-mine');
    const store = sidebarOf(
      managerWithPaths([
        { id: 'd22-home', path: '/root', sessionIds: ['rt-home'], kind: 'workspace' },
        { id: REMOTE_TASK_HOME, path: '/root/.config/咕咕/task-home', sessionIds: ['rt-old'] },
        { id: 'task-home', path: '/me/task-home', sessionIds: ['lt-mine'] },
      ])
    );
    store.machines = machines;

    expect([...store.placement.nodeById.keys()].sort()).toEqual(['lc-mine', 'rc-home', 'rc-old']);
    expect(['lc-mine', 'rc-home', 'rc-old'].map((id) => store.groupOfSession(id))).toEqual([null, null, null]);
    for (const id of ['rt-old', 'rt-home', 'lt-mine']) sessionRegistry.release(id);
  });

  it.each([true, false])('keeps the assistant identity out while retaining its tasks (live=%s)', (live) => {
    acquire('rt-assistant', 'd22-home', 'rc-assistant');
    acquire('rt-executor', 'd22-home', 'rc-executor', 'rc-assistant');
    acquire('rt-grandchild', REMOTE_TASK_HOME, 'rc-grandchild', 'rc-executor');
    acquire('rt-business', 'd22-business', 'rc-business', undefined, 'chat-business');
    listed.set('rc-assistant', { ...listed.get('rc-assistant')!, agent: { userId: 'assistant-id' }, title: 'Renamed assistant', isPinned: true, lastInteractedAt: '2026-11-05T13:00:31.418Z' });
    listed.set('rc-executor', { ...listed.get('rc-executor')!, status: { status: 'needs_user', detail: null } });
    const store = sidebarOf(managerWithPaths([
      { id: 'd22-home', path: '/root', name: 'Internal home', kind: 'workspace', sessionIds: ['rt-assistant', 'rt-executor'] },
      { id: REMOTE_TASK_HOME, path: '/root/.config/app/task-home', sessionIds: ['rt-grandchild'] },
      { id: 'd22-business', path: '/root/business', name: 'Business', sessionIds: ['rt-business'] },
    ]));
    store.machines = { ...machines, isAssistantHome: () => true, label: () => 'Renamed assistant',
      sessionsOf: () => ({ sessions: [...listed.values()], live }) };
    store.setAssistantAgentId('assistant-id');
    try {
      expect(store.placement.nodeById.has('rc-assistant')).toBe(false);
      expect(['rc-executor', 'rc-grandchild'].map((id) => store.groupOfSession(id))).toEqual([null, null]);
      expect(store.placement.nodeById.get('rc-executor')?.item.group).toBe('needs-you');
      expect(store.placement.entries.get('chat-business')?.map((e) => e.id)).toEqual(['rc-business']);
    } finally {
      for (const id of ['rt-assistant', 'rt-executor', 'rt-grandchild', 'rt-business']) sessionRegistry.release(id);
    }
  });

  it('recognizes the provisioned assistant after moving it, without hiding delegated tasks', () => {
    acquire('rt-asst', REMOTE_TASK_HOME, 'rc-asst');
    acquire('rt-kid', REMOTE_TASK_HOME, 'rc-kid', 'rc-asst');
    acquire('rt-other', REMOTE_TASK_HOME, 'rc-other');
    listed.set('rc-asst', { ...listed.get('rc-asst')!, agent: { userId: 'u-asst' } });
    listed.set('rc-kid', { ...listed.get('rc-kid')!, agent: { userId: 'u-kid' } });
    const store = sidebarOf(
      managerWithPaths([{ id: REMOTE_TASK_HOME, path: '/root/.config/咕咕/task-home', sessionIds: ['rt-asst', 'rt-kid', 'rt-other'] }])
    );
    store.machines = machines;
    const shown = () => [...store.placement.nodeById.keys()].sort();

    // 对照:还不知道助理是谁时,它那条在、子 agent 挂在它下面。
    expect(shown()).toEqual(['rc-asst', 'rc-kid', 'rc-other']);
    expect(store.parentOf('rc-kid')).toBe('rc-asst');
    expect(store.launchedByAssistant(REMOTE_TASK_HOME, 'rc-kid')).toBe(false);

    store.setAssistantAgentId('u-asst');
    expect(shown()).toEqual(['rc-kid', 'rc-other']);
    expect(store.remoteSession(REMOTE_TASK_HOME, 'rc-asst')).toBeNull();
    expect(store.launchedByAssistant(REMOTE_TASK_HOME, 'rc-kid')).toBe(true);
    expect(store.launchedByAssistant(REMOTE_TASK_HOME, 'rc-other')).toBe(false);
    // Only the canonical identity is hidden; a matching title or project is insufficient.
    store.setAssistantAgentId('u-kid');
    expect(shown()).toEqual(['rc-asst', 'rc-other']);
    for (const id of ['rt-asst', 'rt-kid', 'rt-other']) sessionRegistry.release(id);
  });

  // owner 2026-10-01:别的机器上的 agent 也挂在本机的 agent 下面(反过来也一样),会话列表按「谁派的谁」成组。
  it('跨机器的 child 跟着父会话走,❌ 留在自己的群里', () => {
    acquire('lt-parent', 'task-home', 'lc-parent');
    acquire('rt-child', 'd22-app', 'rc-child', 'lc-parent', 'chat-app');
    acquire('rt-root', 'd22-app', 'rc-root', undefined, 'chat-app');
    acquire('lt-kid', 'local-proj', 'lc-kid', 'rc-root', 'chat-local');
    const store = sidebarOf(
      managerWithPaths([
        { id: 'task-home', path: '/me/task-home', sessionIds: ['lt-parent'] },
        { id: 'd22-app', path: '/root/app', sessionIds: ['rt-child', 'rt-root'] },
        { id: 'local-proj', path: '/me/proj', sessionIds: ['lt-kid'] },
      ])
    );
    store.machines = machines;

    // 本机「任务」分区里的父会话下面挂着 d22 上的 child。
    expect(['lc-parent', 'rc-child'].map((id) => store.groupOfSession(id))).toEqual([null, null]);
    expect(store.parentOf('rc-child')).toBe('lc-parent');
    // d22 的群下:它自己的根会话,下面挂着本机的 child;本机那个群下没有行。
    expect(store.placement.entries.get('chat-app')?.map((e) => e.id).sort()).toEqual(['lc-kid', 'rc-root']);
    expect(store.placement.entries.get('chat-local')).toBeUndefined();
    expect(store.groupOfSession('lt-kid'), 'keyed by the page session').toBe('chat-app');
    for (const sessionId of ['lt-parent', 'rt-child', 'rt-root', 'lt-kid']) sessionRegistry.release(sessionId);
  });

  it('列出不挂载:没挂上的那台机器的项目照样列出会话目录里的会话(打开就先画上次的样子)', () => {
    acquire('rt-listed', 'd22-app', 'rc-listed', undefined, 'chat-app');
    sessionRegistry.release('rt-listed');
    const store = sidebarOf({
      projects: new Map([
        ['d22-app', { id: 'd22-app', name: 'app', createdAt: '2026-01-01T00:00:00.000Z', data: { path: '/root/app' }, mountedProject: undefined }],
      ]),
    } as unknown as SidebarProjectManager);
    store.machines = machines;
    expect(store.placement.entries.get('chat-app')).toEqual([
      expect.objectContaining({ sessionId: 'rc-listed', projectId: 'd22-app', groupChatId: 'chat-app' }),
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
      for (const entry of allEntries(store)) if (entry.group) counts[entry.group] = (counts[entry.group] ?? 0) + 1;
      return counts;
    };
    expect(groups()).toEqual({ 'needs-you': 1, working: 1 });
    expect(store.placement.nodeById.get('rc-pin')?.item.isPinned).toBe(true);
    runInAction(() => (live = false));
    store.machines = { ...machines, sessionsOf: () => ({ sessions: [...listed.values()], live }) };
    expect(groups()).toEqual({ 'needs-you': 1 });
  });
});

// Only explicit disclosure controls change persisted session and section choices.
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

  it('persists manual conversation and overflow choices across a restart', () => {
    const source = twoProjects();
    source.toggleSessionExpanded('expanded-parent');
    source.toggleSessionExpanded('collapsed-parent');
    source.toggleSessionExpanded('collapsed-parent');
    source.toggleIdleExpanded('fold-a');
    const saved = structuredClone(source.snapshot);
    const restored = twoProjects();
    restored.restoreSnapshot(saved);
    expect([...restored.expandedSessionIds]).toEqual(['expanded-parent']);
    expect([...restored.idleExpandedProjectIds]).toEqual(['fold-a']);
    expect(restored.expandedSessionIds.has('collapsed-parent')).toBe(false);
  });

  it('keeps what the user folded away across a restart', () => {
    const source = twoProjects();
    setSidebarFold('left', true);
    setSidebarFold('inner:topics', true);
    const saved = structuredClone(source.snapshot);
    sidebarFolds.clear();
    twoProjects().restoreSnapshot(saved);
    expect([...sidebarFolds].sort()).toEqual(['inner:topics', 'left']);
    sidebarFolds.clear();
  });

  it('does not open a parent when new descendants or activity arrive', () => {
    const page = 'task-manual';
    const manager = projectManagerWithSessions([
      { id: 'project-a', createdAt: '2026-01-01T00:00:00.000Z', sessionIds: [page] },
    ]);
    const store = sidebarOf(manager);
    const parent = session('manual-parent');
    try {
      sessionRegistry.acquire(page, 'project-a', [parent] as never);
      store.toggleSessionExpanded(parent.id);
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

  it('a blob written by an older sidebar (section folds, project rows, 项目 | 对话 layout and page, sessionSortBy) still restores; those fields are ignored (#2548)', () => {
    const restored = twoProjects();
    restored.restoreSnapshot({
      expandedProjectIds: ['project-a'],
      projectOrder: ['project-a'],
      sessionSortBy: 'updated-at',
      pinnedCollapsed: true,
      projectsCollapsed: true,
      sessionsCollapsed: true,
      chatsCollapsed: true,
      listLayout: 'merged',
      listPage: 'chats',
    } as Parameters<SidebarStore['restoreSnapshot']>[0]);
    expect(Object.keys(restored.snapshot).sort()).toEqual([
      'expandedSessionIds',
      'folds',
      'idleExpandedProjectIds',
    ]);
  });
});
