import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { RemovedSessionIdentity } from '@gugu/core/shared/sessionArchival';

/**
 * owner 2026-11-26「已归档 → 永久删除」,打在真 SQLite 和真文件上:只删已归档的;先云端、后本机;云端没回执本机不动;
 * 子树叶子先、还在用的子会话不动;引擎记录只删咕咕托管配置根里的;用户自己的 ~/.claude 一个字节不碰。
 */
const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  // One userData for the file: the timeline archive resolves its root once per module.
  userData: '',
  managedRoot: '',
  userRoot: '',
}));
mocks.userData = mkdtempSync(join(tmpdir(), 'gugu-permanent-delete-'));
mocks.managedRoot = join(mocks.userData, 'gugu-home', 'agent-homes', 'claude', '.claude');
mocks.userRoot = join(mocks.userData, 'user-home', '.claude');

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData }, clipboard: {}, nativeImage: {} }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('./session-life', async importOriginal => ({
  ...await importOriginal<typeof import('./session-life')>(),
  sessionLife: () => ({ interrupt: vi.fn(async () => undefined), restore: vi.fn() }),
}));
vi.mock('./sendMessage', () => ({ drainSessionMessageOutbox: vi.fn(async () => undefined) }));
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { getProject: () => undefined } }));
vi.mock('@main/core/session-import/host-source', () => ({ hasLocalSessionSource: () => false }));
vi.mock('@main/core/sessions/session-workspace-manager', () => ({
  sessionWorkspaceManager: { getSession: () => undefined, teardownSession: vi.fn(), sessionsOf: () => [], hooks: { on: vi.fn() } },
  cleanupDetachedSessions: vi.fn(),
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('./session-events', () => ({ sessionEvents: { _emit: vi.fn() } }));
vi.mock('../../../../sessionpage/sessionpage-project-groups', () => ({ listProjectGroupIds: async () => [], forgetProjectGroupId: vi.fn() }));
// The managed root under GUGU_HOME and the user's own root, with Claude's real record classifier.
vi.mock('../agents/agent-homes', async () => {
  const { claudeSessionBundleDescriptor } = await import('../../../../../../../packages/session-plugins/src/agents/impl/claude/session-bundle');
  return {
    managedAgentHome: (providerId: string) => providerId !== 'claude' ? null : {
      configRoot: mocks.managedRoot,
      userConfigRoot: mocks.userRoot,
      historySession: claudeSessionBundleDescriptor.configRoot.historySession,
      upgradeHistory: ['projects', 'file-history', 'todos'],
    },
  };
});

const { permanentlyDeleteSessions } = await import('./permanently-delete-session');
const { setSessionIdentityHost } = await import('./session-identity-host');
const { setOtherMachines } = await import('./session-family');
const { sessionEvents } = await import('./session-events');

const identityHost = {
  archive: vi.fn(async (_sessionId: string): Promise<RemovedSessionIdentity | null> => null),
  release: vi.fn(async (_identity: RemovedSessionIdentity) => {}),
  restore: vi.fn(async () => {}),
  history: {} as Record<string, string[]>,
  historyIdentities: vi.fn(async (sessionId: string, current: RemovedSessionIdentity | null) =>
    [...new Set([...(current ? [current.userId] : []), ...(identityHost.history[sessionId] ?? [])])]),
  purgeHistory: vi.fn(async (ids: string[]) => ids),
};

let fixture: Awaited<ReturnType<typeof openFixture>>;
const ARCHIVED_AT = '2026-11-20T00:00:00.000Z';
const REMOVED = (userId: string): RemovedSessionIdentity => ({ userId, removedAt: '2026-11-20T00:00:00Z' });

function insertSession(id: string, opts: { archived?: boolean; removed?: string; parent?: string; workspace?: string; providerSessionId?: string } = {}) {
  fixture.sqlite.prepare(`INSERT INTO sessions (id, project_id, runtime, provider, provider_session_id, archived_at, parent_session_id, workspace_id, config)
    VALUES (?, 'p1', 'acp', 'claude', ?, ?, ?, ?, ?)`).run(
    id, opts.providerSessionId ?? null, opts.archived === false ? null : ARCHIVED_AT, opts.parent ?? null, opts.workspace ?? null,
    JSON.stringify({ version: '1', type: 'acp', agentDisplayName: id })
  );
  if (opts.archived === false) return;
  const state = { sessionId: id, archivedAt: ARCHIVED_AT, revision: 1, intervals: [{ id: `i-${id}`, archivedAt: ARCHIVED_AT, restoredAt: null }],
    ...(opts.removed ? { removedIdentity: REMOVED(opts.removed) } : {}) };
  fixture.sqlite.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)`).run(`session-archival:${id}`, JSON.stringify(state));
}
const exists = (id: string) => !!fixture.sqlite.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
const kvKeys = (prefix: string) => (fixture.sqlite.prepare('SELECT key FROM kv WHERE key LIKE ?').all(`${prefix}%`) as Array<{ key: string }>).map((row) => row.key);
const put = (path: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'x'); return path; };

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
  identityHost.history = {};
  for (const fn of [identityHost.archive, identityHost.release, identityHost.historyIdentities, identityHost.purgeHistory]) fn.mockClear();
  identityHost.archive.mockImplementation(async () => null);
  identityHost.purgeHistory.mockImplementation(async (ids: string[]) => ids);
  vi.mocked(sessionEvents._emit).mockClear();
  setSessionIdentityHost(identityHost);
  setOtherMachines(null);
});
afterEach(() => {
  setSessionIdentityHost(null);
  fixture.close();
  mocks.db = undefined;
});
afterAll(async () => { await rm(mocks.userData, { recursive: true, force: true }); });

describe('permanentlyDeleteSessions', () => {
  it('rejects bad input and more than 50 sessions per call; never deletes an active session', async () => {
    await expect(permanentlyDeleteSessions([{ projectId: 'p1' } as never])).rejects.toThrow('takes [{ projectId, sessionId }]');
    const many = Array.from({ length: 51 }, (_, i) => ({ projectId: 'p1', sessionId: `s${i}` }));
    await expect(permanentlyDeleteSessions(many)).rejects.toThrow('at most 50');
    insertSession('active', { archived: false });
    const outcome = await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'active' }, { projectId: 'p1', sessionId: 'nowhere' }]);
    expect(outcome.deleted).toEqual([]);
    expect(outcome.failed.map((row) => [row.sessionId, row.reason])).toEqual([
      ['active', 'Only archived sessions can be permanently deleted'],
      ['nowhere', 'Session not found on this machine'],
    ]);
    expect(exists('active')).toBe(true);
    expect(identityHost.purgeHistory).not.toHaveBeenCalled();
  });

  it('purges every removed identity in the cloud first, then the row, journal, timeline cache and managed engine records; the user\'s own root is untouched', async () => {
    const provider = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    insertSession('gone', { removed: 'agent-now', providerSessionId: provider, workspace: 'ws-own' });
    identityHost.history.gone = ['agent-before'];
    fixture.sqlite.prepare(`INSERT INTO workspaces (id, type) VALUES ('ws-own', 'local')`).run();
    fixture.sqlite.prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('session-archival-refusal:gone:m1', 'agent_archived', 0)`).run();
    const journal = put(join(mocks.userData, 'session-journal', 'gone.jsonl'));
    const timeline = put(join(mocks.userData, 'session-timeline-archive', 'gone.json'));
    const managed = [
      put(join(mocks.managedRoot, 'projects', '-repo', `${provider}.jsonl`)),
      put(join(mocks.managedRoot, 'projects', '-repo', provider, 'subagents', 'a.jsonl')),
      put(join(mocks.managedRoot, 'file-history', provider, 'f1')),
      put(join(mocks.managedRoot, 'todos', `${provider}-agent-${provider}.json`)),
    ];
    const otherSession = put(join(mocks.managedRoot, 'projects', '-repo', '11111111-2222-3333-4444-555555555555.jsonl'));
    const usersOwn = put(join(mocks.userRoot, 'projects', '-repo', `${provider}.jsonl`));

    const outcome = await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'gone' }]);

    expect(outcome).toEqual({ deleted: [{ projectId: 'p1', sessionId: 'gone' }], unreached: [], failed: [] });
    expect(identityHost.purgeHistory).toHaveBeenCalledWith(['agent-now', 'agent-before']);
    expect(identityHost.archive).not.toHaveBeenCalled();
    expect(exists('gone')).toBe(false);
    expect(kvKeys('session-archival')).toEqual([]);
    expect(fixture.sqlite.prepare("SELECT id FROM workspaces WHERE id = 'ws-own'").get()).toBeUndefined();
    for (const file of [journal, timeline, ...managed]) expect(existsSync(file), file).toBe(false);
    expect(existsSync(otherSession)).toBe(true);
    expect(existsSync(usersOwn)).toBe(true);
    expect(sessionEvents._emit).toHaveBeenCalledWith('session:deleted', 'gone');
    // Survives a restart: the tombstone is a row, not process memory.
    expect(kvKeys('fork-capture-tombstone:').sort()).toEqual([`fork-capture-tombstone:${provider}`, 'fork-capture-tombstone:gone']);
    // Idempotent: asking again (a retried batch) reports it deleted, and touches the cloud no more.
    identityHost.purgeHistory.mockClear();
    expect(await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'gone' }])).toEqual({ deleted: [{ projectId: 'p1', sessionId: 'gone' }], unreached: [], failed: [] });
    expect(identityHost.purgeHistory).not.toHaveBeenCalled();
  });

  it('changes nothing locally when the cloud does not confirm, and the row can be deleted on retry', async () => {
    insertSession('stays', { removed: 'agent-x' });
    const journal = put(join(mocks.userData, 'session-journal', 'stays.jsonl'));
    identityHost.purgeHistory.mockRejectedValueOnce(new Error('Removing the history needs a connection'));
    const outcome = await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'stays' }]);
    expect(outcome.deleted).toEqual([]);
    expect(outcome.failed).toEqual([{ projectId: 'p1', sessionId: 'stays', reason: 'Removing the history needs a connection' }]);
    expect(exists('stays')).toBe(true);
    expect(existsSync(journal)).toBe(true);
    expect(sessionEvents._emit).not.toHaveBeenCalledWith('session:deleted', 'stays');
    // A receipt that leaves an identity out is not a receipt for this row either.
    identityHost.purgeHistory.mockResolvedValueOnce([]);
    expect((await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'stays' }])).failed).toHaveLength(1);
    expect(exists('stays')).toBe(true);
    expect((await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'stays' }])).deleted).toHaveLength(1);
    expect(exists('stays')).toBe(false);
  });

  it('removes a still-present identity first (archive_user(true) path), then purges it', async () => {
    insertSession('kept-identity');
    identityHost.archive.mockResolvedValueOnce(REMOVED('agent-live'));
    const outcome = await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'kept-identity' }]);
    expect(outcome.deleted).toHaveLength(1);
    expect(identityHost.archive).toHaveBeenCalledWith('kept-identity', undefined);
    expect(identityHost.release).toHaveBeenCalledWith(REMOVED('agent-live'));
    expect(identityHost.purgeHistory).toHaveBeenCalledWith(['agent-live']);
    expect(identityHost.archive.mock.invocationCallOrder[0]).toBeLessThan(identityHost.purgeHistory.mock.invocationCallOrder[0]);
  });

  it('with children: archived descendants leaf first, an active child stays (now top level)', async () => {
    insertSession('root', { removed: 'a-root' });
    insertSession('child', { parent: 'root', removed: 'a-child' });
    insertSession('grandchild', { parent: 'child', removed: 'a-grand' });
    insertSession('busy-child', { parent: 'root', archived: false });
    const outcome = await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'root' }], { withChildren: true });
    expect(outcome.deleted.map((row) => row.sessionId)).toEqual(['grandchild', 'child', 'root']);
    expect(outcome.failed).toEqual([]);
    expect(exists('busy-child')).toBe(true);
    expect(fixture.sqlite.prepare("SELECT parent_session_id AS p FROM sessions WHERE id = 'busy-child'").get()).toEqual({ p: null });
  });

  it('keeps a workspace row another session or a project still uses', async () => {
    fixture.sqlite.prepare(`INSERT INTO workspaces (id, type) VALUES ('ws-shared', 'local'), ('ws-root', 'local')`).run();
    fixture.sqlite.prepare(`UPDATE projects SET repository_workspace_id = 'ws-root' WHERE id = 'p1'`).run();
    insertSession('one', { removed: 'a1', workspace: 'ws-shared' });
    insertSession('two', { archived: false, workspace: 'ws-shared' });
    insertSession('three', { removed: 'a3', workspace: 'ws-root' });
    await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'one' }, { projectId: 'p1', sessionId: 'three' }]);
    expect(fixture.sqlite.prepare("SELECT id FROM workspaces ORDER BY id").all()).toEqual([{ id: 'ws-root' }, { id: 'ws-shared' }]);
  });

  it('chunks the cloud purge at 50 identities and only fails the rows whose identities were in the failed chunk', async () => {
    for (let i = 0; i < 30; i += 1) {
      insertSession(`s${i}`, { removed: `a${i}` });
      identityHost.history[`s${i}`] = [`b${i}`];
    }
    identityHost.purgeHistory.mockImplementation(async (ids: string[]) => {
      if (ids.includes('a29')) throw new Error('cloud down');
      return ids;
    });
    const outcome = await permanentlyDeleteSessions(Array.from({ length: 30 }, (_, i) => ({ projectId: 'p1', sessionId: `s${i}` })));
    const calls = identityHost.purgeHistory.mock.calls.map(([ids]) => ids.length);
    expect(calls).toEqual([50, 10]);
    expect(Math.max(...calls)).toBeLessThanOrEqual(50);
    // a0..a24 + b0..b24 went in the first chunk; s25..s29 had identities in the failed one.
    expect(outcome.deleted).toHaveLength(25);
    expect(outcome.failed.map((row) => row.sessionId)).toEqual(['s25', 's26', 's27', 's28', 's29']);
  });

  it('one session with 51 identities takes 2 cloud calls and is deleted only when both chunks confirm', async () => {
    insertSession('many', { removed: 'now' });
    identityHost.history.many = Array.from({ length: 50 }, (_, i) => `old${i}`);
    identityHost.purgeHistory.mockImplementation(async (ids: string[]) => (ids.includes('old49') ? [] : ids));
    expect((await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'many' }])).failed).toHaveLength(1);
    expect(identityHost.purgeHistory.mock.calls.map(([ids]) => ids.length)).toEqual([50, 1]);
    expect(exists('many')).toBe(true);
    identityHost.purgeHistory.mockImplementation(async (ids: string[]) => ids);
    expect((await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'many' }])).deleted).toHaveLength(1);
    expect(exists('many')).toBe(false);
  });

  it('puts every row into failed (no throw) when no identity host is connected', async () => {
    insertSession('lonely', { removed: 'a' });
    setSessionIdentityHost(null);
    const outcome = await permanentlyDeleteSessions([{ projectId: 'p1', sessionId: 'lonely' }]);
    expect(outcome.failed.map((row) => row.sessionId)).toEqual(['lonely']);
    expect(exists('lonely')).toBe(true);
  });
});
