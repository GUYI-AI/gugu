// Replacing the engine session of a session-life session: nothing runs until someone speaks.
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  calls: [] as string[],
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
vi.mock('./hydrateSession', () => ({ hydrateSession: vi.fn(async () => { mocks.calls.push('hydrate'); }) }));
vi.mock('./session-life', () => {
  return { sessionLife: () => ({
  interrupt: async (sessionId: string, event: { reason: string }) => { mocks.calls.push(`${event.reason}:${sessionId}`); },
  start: (sessionId: string, origin: string) => { mocks.calls.push(`start:${sessionId}:${origin}`); },
  }) };
});

import { restartSession } from './restart-session';

describe('restartSession on a session-life session', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    mocks.calls = [];
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    const config = JSON.stringify({ version: '1', type: 'acp', agentDisplayName: 'T', firstUtterance: '把测试跑一遍', initialQueue: [{ text: '把测试跑一遍', origin: 'manual' }] });
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
    expect(mocks.calls).toEqual(['reconfigure:s']);
    expect(pendingRows()).toEqual([]);
    const { providerSessionId, config } = stored();
    expect(providerSessionId).toBeNull();
    expect(config).not.toHaveProperty('initialQueue');
    expect(config).not.toHaveProperty('initialPrompt');
    expect(config).not.toHaveProperty('initialMessageId');
    expect(config.firstUtterance).toBe('把测试跑一遍');
  });

  it('marks where the prior conversation ends, each time', async () => {
    await restartSession('p', 's');
    expect(stored().config.priorTurnsBefore).toBe(0);
    fixture.sqlite.prepare("INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES ('s:6', 's', 6, 't', '{}')").run();
    await restartSession('p', 's');
    expect(stored().config.priorTurnsBefore).toBe(7);
  });

  it('input already waiting was really said: it starts the session and is delivered', async () => {
    const { enqueuePending } = await import('./session-pending');
    enqueuePending({ sessionId: 's', messageId: 'waiting', text: '接着做', kind: 'ordinary', turn: { kind: 'prompt', origin: 'manual' } });
    await restartSession('p', 's');
    expect(mocks.calls).toEqual(['reconfigure:s', 'start:s:retry']);
  });
});
