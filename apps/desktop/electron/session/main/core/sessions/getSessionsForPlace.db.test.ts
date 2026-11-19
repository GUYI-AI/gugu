import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mock = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mock.db) throw new Error('Missing fixture'); return mock.db; } }));
const { getSessionsForFolder, getSessionsForGroup } = await import('./getSessionsForPlace');

let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  fixture = await openFixture(); mock.db = fixture.db;
  // /repo is group g's folder; /repo/wt a worktree of it; /repo/sub a folder of its own nested inside; /repo-two only
  // shares the prefix; the task home has no group.
  fixture.sqlite.exec(`
    INSERT INTO workspaces (id, type, kind, location, path, key, chat_id) VALUES
      ('repo', 'local', 'project-root', 'local', '/repo', 'k-repo', 'g'),
      ('sub', 'local', 'project-root', 'local', '/repo/sub', 'k-sub', NULL),
      ('two', 'local', 'project-root', 'local', '/repo-two', 'k-two', NULL),
      ('home', 'local', 'project-root', 'local', '/home/me/task-home', 'k-home', NULL);
    INSERT INTO workspaces (id, type, kind, path) VALUES ('wt', 'local', 'worktree', '/repo/wt'), ('sub-wt', 'local', 'worktree', '/repo/sub/wt');
  `);
  const insert = fixture.sqlite.prepare(`INSERT INTO sessions (id, project_id, chat_id, workspace_id, config, archived_at)
    VALUES (?, 'c1-placeholder', ?, ?, json_object('version', '1', 'type', 'acp', 'agentDisplayName', ?), ?)`);
  insert.run('in-root', 'g', 'repo', 'in-root', null);
  insert.run('in-worktree', 'g', 'wt', 'in-worktree', null);
  insert.run('archived', 'g', 'repo', 'archived', '2026-11-19T00:00:00Z');
  insert.run('in-nested', null, 'sub', 'in-nested', null);
  insert.run('in-nested-worktree', 'g', 'sub-wt', 'in-nested-worktree', null);
  insert.run('in-two', null, 'two', 'in-two', null);
  insert.run('at-home', null, 'home', 'at-home', null);
});
afterEach(() => { fixture.close(); mock.db = undefined; });

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();

it('a folder: its own sessions and its worktrees’, not a nested folder’s, not a path that only shares the prefix', async () => {
  expect(ids(await getSessionsForFolder('repo'))).toEqual(['in-root', 'in-worktree']);
  expect(ids(await getSessionsForFolder('sub'))).toEqual(['in-nested', 'in-nested-worktree']);
  expect(ids(await getSessionsForFolder('two'))).toEqual(['in-two']);
});

it('a folder without a group (the task home) has its sessions too', async () => {
  expect(ids(await getSessionsForFolder('home'))).toEqual(['at-home']);
});

it('a folder this machine does not have is an error, not an empty list', async () => {
  await expect(getSessionsForFolder('nowhere')).rejects.toThrow('folder nowhere not found');
});

it('a group: the sessions that live in it, wherever they work', async () => {
  expect(ids(await getSessionsForGroup('g'))).toEqual(['in-nested-worktree', 'in-root', 'in-worktree']);
});
