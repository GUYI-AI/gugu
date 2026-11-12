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

const { upgradeProjectPinsToSidebarOnce } = await import('./sidebar-pin-upgrade');
const upgrade = () => upgradeProjectPinsToSidebarOnce().length;

// #2548「Upgrade」: the first start with the one-list sidebar pins the project-pinned sessions to the sidebar, once;
// standalone pinned sessions, children and unpinned ones are left alone; afterwards only the person's choices count.
describe('sidebar pin upgrade', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path, kind) VALUES ('project-1', 'Project', '/repo', 'project');
      INSERT INTO projects (id, name, path, kind) VALUES ('tasks', 'Tasks', '/task-home', 'workspace');
      INSERT INTO sessions (id, project_id, is_pinned) VALUES ('project-pinned', 'project-1', 1);
      INSERT INTO sessions (id, project_id, is_pinned, archived_at) VALUES ('project-pinned-archived', 'project-1', 1, '2026-11-01');
      INSERT INTO sessions (id, project_id, is_pinned) VALUES ('project-unpinned', 'project-1', 0);
      INSERT INTO sessions (id, project_id, is_pinned, parent_session_id) VALUES ('project-pinned-child', 'project-1', 1, 'project-pinned');
      INSERT INTO sessions (id, project_id, is_pinned, config) VALUES ('project-pinned-remote-child', 'project-1', 1,
        '{"version":"1","type":"acp","parentRemote":{"deviceId":"device-2","sessionId":"remote-parent"}}');
      INSERT INTO sessions (id, project_id, is_pinned) VALUES ('standalone-pinned', 'tasks', 1);
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  const pinnedToSidebar = () =>
    (fixture.sqlite.prepare('SELECT id FROM sessions WHERE is_pinned_to_sidebar = 1 ORDER BY id').all() as { id: string }[])
      .map((row) => row.id);
  const pinned = () =>
    (fixture.sqlite.prepare('SELECT id FROM sessions WHERE is_pinned = 1 ORDER BY id').all() as { id: string }[])
      .map((row) => row.id);
  const marker = () => fixture.sqlite.prepare("SELECT value FROM app_settings WHERE key = 'migration.sidebar-pin-upgrade-v1'").get();

  it('pins exactly the top-level project-pinned sessions to the sidebar; they stay 置顶', () => {
    const before = pinned();
    expect(upgrade()).toBe(2);
    expect(pinnedToSidebar()).toEqual(['project-pinned', 'project-pinned-archived']);
    expect(pinned()).toEqual(before);
    expect(marker()).toBeDefined();
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: 'project-pinned',
      projectId: 'project-1',
      changes: { isPinnedToSidebar: true },
    });
    expect(mocks.emit).toHaveBeenCalledTimes(2);
  });

  it('runs once: the person unpinning one afterwards is never undone, and new project pins are not converted', () => {
    upgrade();
    mocks.emit.mockReset();
    fixture.sqlite.exec(`
      UPDATE sessions SET is_pinned_to_sidebar = 0 WHERE id = 'project-pinned';
      UPDATE sessions SET is_pinned = 1 WHERE id = 'project-unpinned';
    `);

    expect(upgrade()).toBe(0);
    expect(pinnedToSidebar()).toEqual(['project-pinned-archived']);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
