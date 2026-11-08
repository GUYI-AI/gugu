// Replacing the engine session of a session-life session: nothing runs until someone speaks.
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  calls: [] as string[],
  failure: null as null | { cause: { name: string; message: string; data?: string } },
}));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { restart: vi.fn(async () => {}) } }));
vi.mock('@main/core/acp/runtime-process/host', () => ({ forgetLostAcpSession: vi.fn(async (sessionId: string) => { mocks.calls.push(`forget:${sessionId}`); }) }));
vi.mock('./hydrateSession', () => ({ hydrateSession: vi.fn(async () => { mocks.calls.push('hydrate'); }) }));
vi.mock('./session-life', () => {
  return { sessionLife: () => ({
  interrupt: async (sessionId: string, event: { reason: string }) => { mocks.calls.push(`${event.reason}:${sessionId}`); mocks.failure = null; },
  start: (sessionId: string, origin: string) => { mocks.calls.push(`start:${sessionId}:${origin}`); },
  read: () => ({ kind: mocks.failure ? 'failed' : 'dormant', failure: mocks.failure }),
  }) };
});

import { restartSession } from './restart-session';

describe('restartSession on a session-life session', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    mocks.calls = [];
    mocks.failure = null;
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    const config = JSON.stringify({ version: '1', type: 'acp', agentDisplayName: 'T', providerSessionState: 'missing', firstUtterance: '把测试跑一遍', initialMessageId: 'first', initialQueue: [{ text: '把测试跑一遍', origin: 'manual' }] });
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
    `);
    fixture.sqlite.prepare("INSERT INTO sessions (id, project_id, workspace_id, title, runtime, provider_session_id, config) VALUES ('s', 'p', 'root', 'T', 'acp', 'native-gone', ?)").run(config);
  });
  afterEach(() => { fixture.close(); mocks.db = undefined; });

  const pendingRows = () => fixture.sqlite.prepare("SELECT message_id AS id FROM session_pending WHERE session_id = 's'").all();
  const stored = () => {
    const row = fixture.sqlite.prepare("SELECT provider_session_id AS p, config FROM sessions WHERE id = 's'").get() as { p: string | null; config: string };
    return { providerSessionId: row.p, config: JSON.parse(row.config) as Record<string, unknown> };
  };

  it('clears the engine session and runs nothing: no row, no start, the first turn is not replayed', async () => {
    await restartSession('p', 's');
    expect(mocks.calls).toEqual(['reconfigure:s', 'forget:s']);
    expect(pendingRows()).toEqual([]);
    const { providerSessionId, config } = stored();
    expect(providerSessionId).toBeNull();
    expect(config).not.toHaveProperty('initialQueue');
    expect(config).not.toHaveProperty('initialPrompt');
    expect(config).not.toHaveProperty('initialMessageId');
    expect(config.firstUtterance).toBe('把测试跑一遍');
  });

  it('replaces only an engine session that is missing: a second click (another window, the phone) does nothing', async () => {
    expect(await restartSession('p', 's')).toEqual({ replaced: true });
    fixture.sqlite.prepare("UPDATE sessions SET provider_session_id = 'new-engine' WHERE id = 's'").run();
    mocks.calls = [];
    expect(await restartSession('p', 's')).toEqual({ replaced: false });
    expect(mocks.calls).toEqual([]);
    expect(stored().providerSessionId).toBe('new-engine');
  });

  const startFailed = (type: string) => ({ cause: { name: 'AcpStartFailed', message: `did not start: ${type}`, data: JSON.stringify({ type }) } });
  const unmarked = () => {
    const config = { ...stored().config };
    delete config.providerSessionState;
    fixture.sqlite.prepare("UPDATE sessions SET provider_session_id = NULL, config = ? WHERE id = 's'").run(JSON.stringify(config));
  };

  it('a start that failed on the missing engine session is replaceable even when the mark could not be written', async () => {
    unmarked();
    expect(await restartSession('p', 's')).toEqual({ replaced: false });
    mocks.failure = startFailed('provider_session_missing');
    expect(await restartSession('p', 's')).toEqual({ replaced: true });
    expect(mocks.calls).toEqual(['reconfigure:s', 'forget:s']);
  });

  it('a start that failed for another reason (quota, sign-in, network) keeps its engine session', async () => {
    fixture.sqlite.prepare("UPDATE sessions SET config = json_remove(config, '$.providerSessionState') WHERE id = 's'").run();
    mocks.failure = startFailed('quota_exceeded');
    expect(await restartSession('p', 's')).toEqual({ replaced: false });
    expect(stored().providerSessionId).toBe('native-gone');
    expect(mocks.calls).toEqual([]);
  });

  it('two clicks at once with no engine session id: one replaces, the other does nothing', async () => {
    unmarked();
    mocks.failure = startFailed('provider_session_missing');
    const results = await Promise.all([restartSession('p', 's'), restartSession('p', 's')]);
    expect(results.map(result => result.replaced).sort()).toEqual([false, true]);
    expect(mocks.calls).toEqual(['reconfigure:s', 'forget:s']);
  });

  it('a first turn still queued (the engine died on its first dispatch) keeps its message id, so it can still be delivered', async () => {
    const { enqueuePending } = await import('./session-pending');
    enqueuePending({ sessionId: 's', messageId: 'first', text: '把测试跑一遍', kind: 'ordinary', turn: { kind: 'chat-page-first-turn' } });
    await restartSession('p', 's');
    expect(stored().config.initialMessageId).toBe('first');
    expect(mocks.calls).toEqual(['reconfigure:s', 'forget:s', 'start:s:retry']);
  });

  it('input already waiting was really said: it starts the session and is delivered', async () => {
    const { enqueuePending } = await import('./session-pending');
    enqueuePending({ sessionId: 's', messageId: 'waiting', text: '接着做', kind: 'ordinary', turn: { kind: 'prompt', origin: 'manual' } });
    await restartSession('p', 's');
    expect(mocks.calls).toEqual(['reconfigure:s', 'forget:s', 'start:s:retry']);
  });
});
