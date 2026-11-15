import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { setSessionPinnedToSidebar } = await import('./setSessionPinnedToSidebar');
const { setSessionPinned } = await import('./setSessionPinned');
const { mapSessionRowToSession } = await import('./utils');
const { sessions } = await import('@main/db/schema');
const { eq } = await import('drizzle-orm');

// #2548 固定到左侧栏: one write path like 置顶 — the column, the session the renderer reads back, one change event.
describe('setSessionPinnedToSidebar', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
        VALUES ('conv-1', 'project-1', 'codex', 'acp', '{"version":"1","type":"acp","agentDisplayName":"Parent"}');
      INSERT INTO sessions (id, project_id, provider, runtime, config, parent_session_id)
        VALUES ('child-1', 'project-1', 'codex', 'acp', '{"version":"1","type":"acp","agentDisplayName":"Child"}', 'conv-1');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  const reread = async (id: string) => {
    const [row] = await fixture.db.select().from(sessions).where(eq(sessions.id, id));
    return mapSessionRowToSession(row!);
  };

  it('starts unpinned on a session written before it existed', async () => {
    expect((await reread('conv-1')).isPinnedToSidebar).toBe(false);
  });

  it('round-trips through the column and the session the renderer reads, announcing the change', async () => {
    await setSessionPinnedToSidebar('conv-1', true);
    expect(fixture.sqlite.prepare('SELECT is_pinned_to_sidebar FROM sessions WHERE id = ?').get('conv-1'))
      .toEqual({ is_pinned_to_sidebar: 1 });
    expect((await reread('conv-1')).isPinnedToSidebar).toBe(true);
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: 'conv-1',
      projectId: 'project-1',
      changes: { isPinnedToSidebar: true },
    });

    await setSessionPinnedToSidebar('conv-1', false);
    expect((await reread('conv-1')).isPinnedToSidebar).toBe(false);
    expect(mocks.emit).toHaveBeenLastCalledWith(sessionChangedChannel, {
      sessionId: 'conv-1',
      projectId: 'project-1',
      changes: { isPinnedToSidebar: false },
    });
  });

  it('is independent of 置顶 in both directions', async () => {
    await setSessionPinned('conv-1', true);
    expect((await reread('conv-1')).isPinnedToSidebar).toBe(false);
    await setSessionPinnedToSidebar('conv-1', true);
    await setSessionPinned('conv-1', false);
    const session = await reread('conv-1');
    expect(session.isPinned).toBe(false);
    expect(session.isPinnedToSidebar).toBe(true);
  });

  it('refuses to pin a child session (never a row of the left list) but still lets one be unpinned', async () => {
    await expect(setSessionPinnedToSidebar('child-1', true)).rejects.toThrow(/top-level/);
    expect((await reread('child-1')).isPinnedToSidebar).toBe(false);
    expect(mocks.emit).not.toHaveBeenCalled();

    fixture.sqlite.exec(`UPDATE sessions SET is_pinned_to_sidebar = 1 WHERE id = 'child-1'`);
    await setSessionPinnedToSidebar('child-1', false);
    expect((await reread('child-1')).isPinnedToSidebar).toBe(false);
  });

  it('announces nothing for a session that does not exist', async () => {
    await expect(setSessionPinnedToSidebar('missing', true)).rejects.toThrow(/not found/);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
