import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

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
  getPlugin: vi.fn(() => ({ capabilities: { hooks: { kind: 'config', supportedEvents: ['start', 'stop', 'notification', 'error'] } }, behavior: {} })),
  isValidProviderId: vi.fn(() => true),
}));

vi.mock('@main/core/agent-hooks/notification', () => ({ maybeShowNotification: vi.fn() }));
const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { statusWritesSettled } = await import('./_support/status-writes-settled');
const { agentStatusWriter } = await import('./agent-status-writer');

describe('acknowledged persistent quota errors', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty'); mocks.db = fixture.db;
    fixture.sqlite.prepare("INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')").run();
    for (const id of ['c1', 'c2']) fixture.sqlite.prepare("INSERT INTO sessions (id, project_id, provider, runtime, agent_status, agent_status_seen) VALUES (?, 'p1', 'claude', 'acp', 'idle', 1)").run(id);
    await agentHookService.initialize(); agentStatusWriter.initialize();
  });
  afterEach(() => { agentStatusWriter.dispose(); agentHookService.dispose(); fixture.close(); mocks.db = undefined; });
  const row = (id = 'c1') => fixture.sqlite.prepare('SELECT agent_status AS status, agent_status_seen AS seen FROM sessions WHERE id = ?').get(id);
  async function event(type: 'start' | 'error' | 'stop' | 'wait', message?: string, id = 'c1', modelId = 'model-a') {
    agentHookService.emitAgentEvent({ type, sessionId: id, projectId: 'p1', providerId: 'claude', timestamp: Date.now(), payload: { message, modelId } });
    await statusWritesSettled(agentStatusWriter, id);
  }
  const weekly = "You've hit your weekly limit · resets Nov 15, 7am (America/Los_Angeles)";
  async function fail(message = weekly, id = 'c1', modelId = 'model-a') { await event('start', undefined, id, modelId); await event('error', message, id, modelId); }
  it('opening acknowledges the error durably, repeated retries retain error with no new unread, and another session still notifies', async () => {
    await fail(); expect(row()).toEqual({ status: 'error', seen: 0 });
    await agentStatusWriter.markSeen('c1'); expect(row()).toEqual({ status: 'error', seen: 1 });
    await fail(); expect(row()).toEqual({ status: 'error', seen: 1 });
    // Process restart: the acknowledgement survives, independently of writer memory.
    agentStatusWriter.dispose(); agentStatusWriter.initialize();
    await fail(); expect(row()).toEqual({ status: 'error', seen: 1 });
    await fail(weekly, 'c2'); expect(row('c2')).toEqual({ status: 'error', seen: 0 });
  });
  it('does not deduplicate a failure nobody has opened', async () => {
    await fail(); await fail(); expect(row()).toEqual({ status: 'error', seen: 0 });
  });
  it.each([0, 1])('recognizes a stored quota error from before the upgrade (seen=%s)', async seen => {
    fixture.sqlite.prepare("UPDATE sessions SET agent_status = 'error', agent_status_seen = ?, config = ? WHERE id = 'c1'")
      .run(seen, JSON.stringify({ version: '1', type: 'acp', model: 'model-a' }));
    fixture.sqlite.prepare("INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES ('t1', 'c1', 0, 't1', ?)")
      .run(JSON.stringify({ outcome: { kind: 'error', detail: weekly } }));
    if (!seen) await agentStatusWriter.markSeen('c1');
    await fail(); expect(row()).toEqual({ status: 'error', seen: 1 });
  });
  it('a failed durable read cannot poison the writer cache or acknowledge the quota', async () => {
    await fail();
    fixture.sqlite.exec("CREATE TRIGGER reject_seen BEFORE UPDATE OF agent_status_seen ON sessions WHEN NEW.agent_status_seen = 1 BEGIN SELECT RAISE(ABORT, 'read write failed'); END");
    await expect(agentStatusWriter.markSeen('c1')).rejects.toThrow('read write failed');
    expect(row()).toEqual({ status: 'error', seen: 0 });
    fixture.sqlite.exec('DROP TRIGGER reject_seen');
    await agentStatusWriter.markSeen('c1');
    expect(row()).toEqual({ status: 'error', seen: 1 });
    await fail(); expect(row()).toEqual({ status: 'error', seen: 1 });
  });
  it.each(['monthly quota exceeded', 'insufficient_quota'])('acknowledges %s but never acknowledges a real approval', async message => {
    await fail(message); await agentStatusWriter.markSeen('c1'); await fail(message);
    expect(row()).toEqual({ status: 'error', seen: 1 });
    await event('start'); await event('wait'); expect(row()).toEqual({ status: 'needs_user', seen: 0 });
  });
  it.each(['HTTP 429 Too many requests', 'ECONNRESET', 'unknown provider failure'])('keeps transient or unknown errors fresh: %s', async message => {
    await fail(message); await agentStatusWriter.markSeen('c1'); await fail(message);
    expect(row()).toEqual({ status: 'error', seen: 0 });
  });
  it('an intervening network failure does not forget a previously acknowledged quota', async () => {
    await fail(); await agentStatusWriter.markSeen('c1');
    await fail('ECONNRESET'); expect(row()).toEqual({ status: 'error', seen: 0 });
    await agentStatusWriter.markSeen('c1');
    await fail(); expect(row()).toEqual({ status: 'error', seen: 1 });
  });
  it('remembers each acknowledged model limit until a turn actually succeeds', async () => {
    await fail(); await agentStatusWriter.markSeen('c1');
    await fail(weekly, 'c1', 'model-b'); expect(row()).toEqual({ status: 'error', seen: 0 });
    await agentStatusWriter.markSeen('c1');
    await fail(); expect(row()).toEqual({ status: 'error', seen: 1 });
  });
  it('notifies again for a different reset period, model, or successful intervening turn', async () => {
    await fail(); await agentStatusWriter.markSeen('c1');
    await fail(weekly.replace('Nov 15', 'Nov 22')); expect(row()).toEqual({ status: 'error', seen: 0 });
    await agentStatusWriter.markSeen('c1');
    await fail(weekly.replace('Nov 15', 'Nov 22'), 'c1', 'model-b'); expect(row()).toEqual({ status: 'error', seen: 0 });
    await agentStatusWriter.markSeen('c1'); await event('start'); await event('stop');
    await fail(weekly.replace('Nov 15', 'Nov 22'), 'c1', 'model-b'); expect(row()).toEqual({ status: 'error', seen: 0 });
  });
});
