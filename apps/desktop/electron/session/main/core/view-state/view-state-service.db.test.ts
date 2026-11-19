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

import { flushViewState, viewStateService, viewStateSnapshot } from './view-state-service';
import { readViewStateForRestore } from './restore-state';

const lastViewed = (workspaceId: string, sessionId: string) => ({
  currentViewId: 'session',
  viewParams: { session: { workspaceId, sessionId } },
});
/** A snapshot saved by an earlier release names the session's local project. */
const lastViewedBefore = (projectId: string, sessionId: string) => ({
  currentViewId: 'session',
  viewParams: { session: { projectId, sessionId } },
});

// Restoring the last view: only a session known to be deleted here falls back. A session that is simply not in
// this machine's table — because it runs on another machine — is restored as it was.
describe('navigation restore: "not in this table" is not "deleted"', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('local-project', 'Project', '/repo');
      INSERT INTO workspaces (id, type, kind, location, path) VALUES ('ws-local', 'local', 'project-root', 'local', '/repo');
      INSERT INTO legacy_project_aliases (project_id, root_workspace_id, chat_id) VALUES ('local-project', 'ws-local', NULL);
      INSERT INTO sessions (id, project_id, workspace_id, provider, runtime, archived_at)
        VALUES ('archived', 'local-project', 'ws-local', 'claude', 'pty', '2026-10-22T00:00:00Z');
    `);
  });

  afterEach(() => {
    flushViewState();
    fixture.close();
    mocks.db = undefined;
  });

  it('a session of another machine is restored', async () => {
    await viewStateService.save('navigation', lastViewed('server-workspace', 'server-session'));
    expect(await viewStateService.get('navigation')).toEqual(lastViewed('server-workspace', 'server-session'));
    await viewStateService.save('navigation', lastViewedBefore('server-project', 'server-session'));
    expect(await viewStateService.get('navigation')).toEqual(lastViewedBefore('server-project', 'server-session'));
  });

  it('a session deleted from a folder of this machine falls back home', async () => {
    await viewStateService.save('navigation', lastViewed('ws-local', 'deleted-session'));
    expect(await viewStateService.get('navigation')).toEqual({ currentViewId: 'home', viewParams: {} });
  });

  it('a snapshot of an earlier release finds this machine through the legacy project alias', async () => {
    await viewStateService.save('navigation', lastViewedBefore('local-project', 'deleted-session'));
    expect(await viewStateService.get('navigation')).toEqual({ currentViewId: 'home', viewParams: {} });
  });

  it('an archived session still falls back', async () => {
    await viewStateService.save('navigation', lastViewed('ws-local', 'archived'));
    expect(await viewStateService.get('navigation')).toMatchObject({ currentViewId: 'home' });
  });

  it('the restore read returns only the referenced session locations (the view state came with the first frame)', () => {
    expect(readViewStateForRestore(['archived', 'not-here'])).toEqual({ locations: [{ conversationId: 'archived', projectId: 'ws-local' }] });
  });
});

// Written behind: reads see a save at once, the database gets it within a second in one go, and a quit or a signal
// (flushViewState) writes whatever is still held, so nothing typed just before is lost.
describe('view state is written behind and flushed on the way out', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const rows = () => fixture.sqlite.prepare("SELECT key, value FROM kv WHERE key LIKE 'view-state:%' ORDER BY updated_at").all();

  beforeEach(async () => {
    vi.useFakeTimers();
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    flushViewState();
    vi.useRealTimers();
    fixture.close();
    mocks.db = undefined;
  });

  it('a burst of saves is one row write; reads and the snapshot see each save at once', async () => {
    for (const query of ['S', 'Si', 'Sim']) await viewStateService.save('view:a/g/members', { query });
    expect(rows(), 'nothing on disk yet').toEqual([]);
    expect(await viewStateService.get('view:a/g/members')).toEqual({ query: 'Sim' });
    expect(viewStateSnapshot()).toEqual({ 'view:a/g/members': { query: 'Sim' } });
    vi.advanceTimersByTime(1000);
    expect(rows()).toEqual([{ key: 'view-state:view:a/g/members', value: '{"query":"Sim"}' }]);
  });

  it('a save just before the process leaves is on disk once it flushes', async () => {
    await viewStateService.save('view:a/g/draft', { text: 'typed 26 ms before SIGTERM', mentions: [] });
    flushViewState();
    expect(rows()).toEqual([{ key: 'view-state:view:a/g/draft', value: '{"text":"typed 26 ms before SIGTERM","mentions":[]}' }]);
  });

  it('the snapshot lists entries oldest write first, a pending delete is gone from it', async () => {
    await viewStateService.save('a', 1);
    await viewStateService.save('b', 2);
    flushViewState();
    await viewStateService.save('a', 3);
    await viewStateService.del('b');
    await viewStateService.save('c', 4);
    expect(Object.entries(viewStateSnapshot())).toEqual([['a', 3], ['c', 4]]);
    flushViewState();
    expect(Object.entries(viewStateSnapshot()), 'the same order from the database').toEqual([['a', 3], ['c', 4]]);
  });
});
