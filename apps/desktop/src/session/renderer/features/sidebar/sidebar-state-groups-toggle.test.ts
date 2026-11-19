import { describe, expect, it, vi } from 'vitest';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { needsYouCount, sidebarStateGroup } from './session-groups';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import { SidebarStore } from './sidebar-store';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { sidebarOf } from './mirror-account-projects.testing';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@renderer/lib/ipc', () => {
  const ipc = {
  events: { on: vi.fn() },
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
    sessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

function sessionFixture(id: string, createdAt: string) {
  return {
    state: 'provisioned',
    data: { id, isPinned: false, createdAt, updatedAt: createdAt },
  };
}

function projectManagerWith(projectId: string, sessionId: string): SidebarProjectManager {
  return {
    projects: new Map([
      [
        projectId,
        {
          id: projectId,
          createdAt: '2026-01-01T00:00:00.000Z',
          mountedProject: {
            sessionManager: {
              sessions: new Map([[sessionId, sessionFixture(sessionId, '2026-01-01T00:00:00.000Z')]]),
            },
          },
        },
      ],
    ]),
  } as unknown as SidebarProjectManager;
}

function session(
  id: string,
  projectId: string,
  agentStatus: string | null,
  minute: string,
  agentStatusSeen = false
) {
  return {
    id,
    projectId,
    providerId: 'codex',
    title: id,
    lastInteractedAt: `2026-01-01T00:${minute}:00.000Z`,
    runtime: 'pty',
    agentStatus,
    agentStatusSeen,
  };
}

// The project Needs you count reads the sidebar's placement through the shared rule (needsYouCount).
const projectNeedsYou = (store: SidebarStore, projectId: string) => needsYouCount(store.placement.entries.get(projectId) ?? []);

describe('sidebar state groups and the Needs you count', () => {
  it('keeps offline wait/error marks without counting them in Needs you', () => {
    for (const status of ['needs_user', 'error'] as const) {
      const presentation = presentAgentStatus({ reading: { status, detail: null }, hostOnline: false });
      expect(presentation?.tone).toBe(status);
      expect(sidebarStateGroup(presentation)).toBe('needs-you');
    }
    for (const online of [false, true]) {
      const projectId = 'remote-attention-project';
      const store = sidebarOf(projectManagerWith(projectId, 'remote-host'));
      const sessions = (['needs_user', 'error'] as const).map(status => ({
        conversationId: status, projectId, title: status, runtime: 'acp', harness: 'codex',
        agentStatus: status, status: { status, detail: null }, supported: true, lastInteractedAt: null, unseen: true,
      }) as SessionpageSessionSummary);
      store.machines = {
        machineOf: () => 'remote-host', label: () => 'remote-host', homeDir: () => '/work',
        connected: () => online,
        sessionsOf: () => ({ live: online, sessions }),
        session: (_deviceId, id) => sessions.find(session => session.conversationId === id) ?? null,
      };
      expect(projectNeedsYou(store, projectId)).toBe(online ? 2 : 0);
      expect(store.placement.entries.get(projectId)?.map(entry => entry.group)).toEqual(['needs-you', 'needs-you']);
    }
  });
  it('counts failures and waits together in the project Needs you badge (#1165)', () => {
    expect(sidebarStateGroup(presentAgentStatus({ reading: { status: 'error', detail: null } }))).toBe('needs-you');
    expect(sidebarStateGroup(presentAgentStatus({ reading: { status: 'needs_user', detail: 'approval' } }))).toBe('needs-you');
    sessionRegistry.acquire('attention-task', 'attention-project', [
      session('attention-error', 'attention-project', 'error', '01'),
      session('attention-wait', 'attention-project', 'needs_user', '02'),
      session('attention-running', 'attention-project', 'working', '03'),
      session('attention-idle', 'attention-project', null, '04'),
    ] as never);
    const store = sidebarOf(projectManagerWith('attention-project', 'attention-task'));
    try {
      expect(projectNeedsYou(store, 'attention-project')).toBe(2);
      expect(store.placement.entries.get('attention-project')?.map((entry) => entry.id)).toContain('attention-error');
    } finally { sessionRegistry.release('attention-task'); }
  });

  it('a read failure keeps its group and red row but leaves the count, so old failures do not pile up', () => {
    sessionRegistry.acquire('read-task', 'read-project', [
      ...Array.from({ length: 40 }, (_, i) => session(`old-failure-${i}`, 'read-project', 'error', '01', true)),
      session('fresh-failure', 'read-project', 'error', '02'),
    ] as never);
    const store = sidebarOf(projectManagerWith('read-project', 'read-task'));
    try {
      expect(projectNeedsYou(store, 'read-project')).toBe(1);
      expect(store.placement.entries.get('read-project')?.every((entry) => entry.group === 'needs-you')).toBe(true);
    } finally { sessionRegistry.release('read-task'); }
  });
});
