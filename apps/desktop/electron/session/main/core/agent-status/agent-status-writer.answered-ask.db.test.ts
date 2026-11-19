import { openFixture } from '@tooling/utils/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusWritesSettled } from './_support/status-writes-settled';
import type { AppDb } from '@main/db/client';
import type { AgentEvent } from '@shared/core/agents/agentEvents';
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('../agent-hooks/hook-server', () => ({
  HookServer: class {
    async start() {}
    stop() {}
    getPort() {
      return 0;
    }
    createSource(ptyId: string) {
      return { id: `source-${ptyId}`, token: 'token', dispose() {} };
    }
  },
}));
vi.mock('../agent-hooks/event-enricher', () => ({ parseHookEvent: vi.fn() }));
vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: vi.fn() }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn((providerId: string) => ({
    capabilities: {
      hooks: providerId === 'gemini'
        ? { kind: 'none' }
        : { kind: 'config', supportedEvents: ['start', 'stop', 'notification', 'error'] },
    },
    behavior: {},
  })),
  isValidProviderId: vi.fn(() => true),
}));

const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('./agent-status-writer');
const { events } = await import('@main/lib/events');
const { sessionChangedChannel } = await import('@shared/core/sessions/sessionEvents');
const { recordAnsweredAsk, readAnsweredAsks } = await import('../asks/answered-asks');

/**
 * An answered approval stays listed until the session's next turn — the edge that also ends a failure's listing. The answer
 * itself lets the running turn go on and must not clear it. Real SQLite, events carry their own timestamps.
 */
let clock = 1_000_000;
function event(sessionId: string, type: AgentEvent['type']): AgentEvent {
  clock += 1_000;
  return { type, providerId: 'claude', projectId: 'p1', sessionId, timestamp: clock, payload: {} };
}
const ANSWER = { itemId: 'ask-1', kind: 'permission' as const, source: 'app-install' as const, optionId: 'allow',
  option: { optionId: 'allow', name: 'Install' }, resolvedBy: 'mobile', resolvedAt: 5 };

describe('the answered-Ask record', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const deliver = async (e: AgentEvent) => {
    agentHookService.emitAgentEvent(e);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
  };
  beforeAll(async () => {
    await agentHookService.initialize();
    agentStatusWriter.initialize();
  });
  afterAll(() => {
    agentStatusWriter.dispose();
    agentHookService.dispose();
  });
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    vi.mocked(events.emit).mockClear();
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('survives the turn it was answered in and ends when the next turn starts, telling the list', async () => {
    const id = `answered-${clock}`;
    fixture.sqlite.prepare(`INSERT INTO sessions (id, project_id, provider, runtime, agent_status, agent_status_seen) VALUES (?, 'p1', 'claude', 'acp', 'idle', 1)`).run(id);
    await deliver(event(id, 'start'));
    agentStatusWriter.reportHostWait({ sessionId: id, projectId: 'p1', id: 'host-ask:ask-1', open: true });
    await statusWritesSettled(agentStatusWriter, id);
    recordAnsweredAsk(id, ANSWER);
    agentStatusWriter.reportHostWait({ sessionId: id, projectId: 'p1', id: 'host-ask:ask-1', open: false });
    await statusWritesSettled(agentStatusWriter, id);
    await deliver(event(id, 'start'));
    await deliver(event(id, 'stop'));
    expect(readAnsweredAsks().get(id)).toEqual(ANSWER);
    expect(vi.mocked(events.emit)).not.toHaveBeenCalledWith(sessionChangedChannel, expect.objectContaining({ changes: { lastAnswered: true } }));

    await deliver(event(id, 'start'));
    expect(readAnsweredAsks().has(id)).toBe(false);
    expect(vi.mocked(events.emit)).toHaveBeenCalledWith(sessionChangedChannel, { sessionId: id, projectId: 'p1', changes: { lastAnswered: true } });
  });
});
