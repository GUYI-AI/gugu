import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const h = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return h.db; } }));

describe('a folder\'s sessions', () => {
  let fixture: FixtureDb;
  beforeEach(async () => {
    vi.resetModules();
    fixture = await openFixture('empty');
    h.db = fixture.db;
    fixture.sqlite.exec(`INSERT INTO sessions (id, project_id, workspace_id, chat_id, provider, archived_at, config) VALUES
      ('in-folder', 'c1-placeholder', 'folder-a', 'group', 'codex', NULL, '{"version":"1","type":"acp","agentDisplayName":"T"}'),
      ('in-home', 'c1-placeholder', 'home', NULL, 'codex', NULL, '{"version":"1","type":"acp","agentDisplayName":"T"}'),
      ('archived', 'c1-placeholder', 'folder-a', 'group', 'codex', '2026-11-19T00:00:00Z', '{"version":"1","type":"acp","agentDisplayName":"T"}'),
      ('elsewhere', 'c1-placeholder', 'folder-b', 'group', 'codex', NULL, '{"version":"1","type":"acp","agentDisplayName":"T"}')`);
  });
  afterEach(() => fixture.close());

  it('lists the sessions working in that folder, not archived ones, with or without a group', async () => {
    const { getSessionsForFolder } = await import('./getSessionsForGroup');
    expect((await getSessionsForFolder('folder-a')).map((session) => session.id)).toEqual(['in-folder']);
    expect((await getSessionsForFolder('home')).map((session) => session.id)).toEqual(['in-home']);
    expect(await getSessionsForFolder('nothing-here')).toEqual([]);
  });
});
