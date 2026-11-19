import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalPath } from '@gugu/session-shared/canonical-path';

const fixtureRef = vi.hoisted(() => ({
  current: undefined as Awaited<ReturnType<typeof openFixture>> | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    return fixtureRef.current!.db;
  },
  get sqlite() {
    return fixtureRef.current!.sqlite;
  },
}));

const { sessions, projects, workspaces } = await import('@main/db/schema');
const { searchService } = await import('./search-service');

// 已下架的 SSH 远程工作区(#6264)上的会话原样留在库里:命令面板的搜索与「最近」都不能再把它们递出来。
describe('SearchService · sessions on retired remote workspaces', () => {
  beforeEach(async () => {
    fixtureRef.current = await openFixture('empty');
    const { db } = fixtureRef.current;
    // The rollback placeholder project the session rows still name (@@@c1-legacy-project).
    await db.insert(projects).values([{ id: 'p', name: 'placeholder', path: '/placeholder' as CanonicalPath }]);
    await db.insert(workspaces).values([
      { id: 'ws-local', type: 'local', kind: 'project-root', location: 'local', path: '/repo/local' as CanonicalPath },
      { id: 'ws-ssh', type: 'project-ssh', kind: 'project-root', location: 'remote', path: '/srv/remote' as CanonicalPath },
    ]);
    await db.insert(sessions).values([
      { id: 'session-local', projectId: 'p', workspaceId: 'ws-local', config: { version: '1', type: 'acp', agentDisplayName: 'alpha session local' } },
      { id: 'session-ssh', projectId: 'p', workspaceId: 'ws-ssh', config: { version: '1', type: 'acp', agentDisplayName: 'alpha session remote' } },
    ]);
    searchService.initialize();
  });

  afterEach(() => {
    fixtureRef.current?.close();
    fixtureRef.current = undefined;
  });

  it('keeps sessions of retired workspaces out of search results, and indexes no projects', () => {
    const items = searchService.search({ query: 'alpha' });
    expect(items.map((item) => item.id)).toEqual(['session-local']);
    expect(items.every((item) => item.kind === 'session')).toBe(true);
  });

  it('keeps sessions of retired workspaces out of recents', () => {
    const ids = searchService.search({ query: '' }).map((item) => item.id);
    expect(ids).toContain('session-local');
    expect(ids).not.toContain('session-ssh');
  });

  it('returns the interaction timestamp used to order local and remote recents', () => {
    fixtureRef.current!.sqlite.prepare('UPDATE sessions SET last_interacted_at = ? WHERE id = ?')
      .run('2026-11-02T06:00:00.000Z', 'session-local');
    expect(searchService.search({ query: '' }).find(item => item.id === 'session-local'))
      .toMatchObject({ lastInteractedAt: '2026-11-02T06:00:00.000Z' });
  });

  it('does not backfill archived sessions and indexes a restored one again', async () => {
    const { db, sqlite } = fixtureRef.current!;
    sqlite.exec("UPDATE sessions SET archived_at='2026-10-30' WHERE id='session-local'; DELETE FROM search_index;");
    searchService.initialize();
    expect(searchService.search({ query: 'alpha' }).map(item => item.id)).not.toContain('session-local');
    const { eq } = await import('drizzle-orm');
    const { sessionEvents } = await import('../sessions/session-events');
    const { mapSessionRowToSession } = await import('../sessions/utils');
    sqlite.exec("UPDATE sessions SET archived_at=NULL WHERE id='session-local';");
    const row = db.select().from(sessions).where(eq(sessions.id, 'session-local')).get()!;
    sessionEvents._emit('session:created', mapSessionRowToSession(row));
    await vi.waitFor(() => expect(searchService.search({ query: 'alpha' }).map(item => item.id)).toContain('session-local'));
  });
});
