import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, bundledMigrations } from '../../initialize';

describe('0051 session sidebar pin', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  afterEach(() => fixture?.close());

  it('adds the flag unset on existing sessions and keeps their 置顶 as it was', async () => {
    fixture = await openFixture('empty', { through: '0050_session_turn_revision' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p', 'P', '/repo');
      INSERT INTO sessions (id, project_id, is_pinned) VALUES ('pinned', 'p', 1), ('plain', 'p', 0);
    `);
    const migration = bundledMigrations().find(entry => entry.tag === '0051_session_sidebar_pin');
    expect(migration).toBeDefined();
    applyMigrations(sql, [migration!]);
    expect(sql.prepare('SELECT id, is_pinned, is_pinned_to_sidebar FROM sessions ORDER BY id').all()).toEqual([
      { id: 'pinned', is_pinned: 1, is_pinned_to_sidebar: 0 },
      { id: 'plain', is_pinned: 0, is_pinned_to_sidebar: 0 },
    ]);
    sql.exec(`INSERT INTO sessions (id, project_id) VALUES ('new', 'p')`);
    expect(sql.prepare("SELECT is_pinned_to_sidebar FROM sessions WHERE id = 'new'").get()).toEqual({ is_pinned_to_sidebar: 0 });
  });
});
