import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { handleSessionEvent } from './agent-hook-service';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  // What a fork-capture sweep finds on disk for this run: the child rows it registers.
  captured: [] as Array<{ id: string; forkedFrom: string }>,
  sweeps: 0,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/core/sessions/fork-capture', () => ({
  captureExternalForks: vi.fn(async () => {
    mocks.sweeps += 1;
    for (const fork of mocks.captured) {
      await mocks.db!.insert(sessions).values({
        id: fork.id, projectId: 'project-1', workspaceId: 'workspace-1', provider: 'claude', runtime: 'pty',
        config: { agentDisplayName: 'task-fork', version: '1', type: 'pty', permissionMode: 'edit', forkedFrom: { sessionId: fork.forkedFrom } },
        providerSessionId: fork.id,
      }).onConflictDoNothing();
    }
  }),
}));

vi.mock('./hook-server', () => ({ HookServer: class {} }));
vi.mock('./event-enricher', () => ({ parseHookEvent: vi.fn() }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn(() => ({ capabilities: { hooks: { kind: 'config', supportedEvents: ['session'] }, sessionBundle: { sessionpage: {} } }, behavior: {} })),
  isValidProviderId: vi.fn(() => true),
}));

const TASK = '2198914b-9e15-4829-aac8-9624df5eebb4';
const BRANCH = 'f46d134e-64b4-4670-b3d1-a7ebe4a754d9';
const CLEARED = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const ctx = { sessionId: TASK, projectId: 'project-1', providerId: 'claude' };

describe('a hook-reported provider session id', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.captured = [];
    mocks.sweeps = 0;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path, created_at, updated_at)
      VALUES ('project-1', 'Project', '/repo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run();
    fixture.sqlite.prepare(`INSERT INTO workspaces (id, type, kind, location, path, created_at, updated_at)
      VALUES ('workspace-1', 'local', 'worktree', 'local', '/repo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run();
    await fixture.db.insert(sessions).values({
      id: TASK, projectId: 'project-1', workspaceId: 'workspace-1', provider: 'claude', runtime: 'pty',
      config: { agentDisplayName: 'task', version: '1', type: 'pty', permissionMode: 'edit' },
      providerSessionId: TASK,
    });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  const providerSessionIdOf = async (id: string) =>
    (await fixture.db.select().from(sessions).where(eq(sessions.id, id)))[0]?.providerSessionId;

  it('does not move the task onto a branch the person made in its terminal; the branch keeps its own row', async () => {
    // claude `/branch`: the terminal now runs BRANCH, a fork of this task's session that fork capture registers.
    mocks.captured = [{ id: BRANCH, forkedFrom: TASK }];

    await expect(handleSessionEvent(ctx, BRANCH)).resolves.toBeUndefined();

    expect(await providerSessionIdOf(TASK)).toBe(TASK);
    expect(await providerSessionIdOf(BRANCH)).toBe(BRANCH);
  });

  it('still follows a new id that is no other session\'s (`/clear`, a provider-minted id)', async () => {
    await expect(handleSessionEvent(ctx, CLEARED)).resolves.toBe(CLEARED);

    expect(await providerSessionIdOf(TASK)).toBe(CLEARED);
  });

  it('does not sweep for forks when the id is the one the task already has', async () => {
    await expect(handleSessionEvent(ctx, TASK)).resolves.toBe(TASK);

    expect(mocks.sweeps).toBe(0);
  });
});
