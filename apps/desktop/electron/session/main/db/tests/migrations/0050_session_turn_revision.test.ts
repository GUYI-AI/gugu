import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, bundledMigrations } from '../../initialize';

/**
 * 0050: every stored turn counts how many times its content was rewritten. A phone that keeps what it read compares
 * it with its own and reads again only the turns that changed. Seeded in the 0049 shape, then only 0050 is run.
 */
const MIGRATION = bundledMigrations().find((migration) => migration.tag === '0050_session_turn_revision');

describe('0050 session turn revision', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  async function seeded() {
    fixture = await openFixture('empty', { through: '0049_window_projection_packs' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
      INSERT INTO sessions (id, project_id, workspace_id, title, runtime) VALUES ('s', 'p', 'root', 'T', 'acp');
      INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES ('s:0', 's', 0, 't0', '{"a":0}'), ('s:1', 's', 1, 't1', '{"a":1}');
    `);
    return sql;
  }

  it('rows from before it start at revision 0, and running the migrations again changes nothing', async () => {
    const sql = await seeded();
    expect(MIGRATION).toBeDefined();
    applyMigrations(sql, [MIGRATION!]);
    expect(sql.prepare(`SELECT seq, revision FROM session_turns ORDER BY seq`).all()).toEqual([{ seq: 0, revision: 0 }, { seq: 1, revision: 0 }]);
    // An applied migration is recorded; a second start does not run it again (re-adding the column would throw).
    expect(() => applyMigrations(sql, bundledMigrations())).not.toThrow();
    expect(sql.prepare(`SELECT count(*) AS n FROM pragma_table_info('session_turns') WHERE name = 'revision'`).get()).toEqual({ n: 1 });
  });

  it('a rewrite of a turn bumps its revision; writing the same content, or another column, does not', async () => {
    const sql = await seeded();
    applyMigrations(sql, [MIGRATION!]);
    sql.exec(`UPDATE session_turns SET data = '{"a":"late tail"}' WHERE id = 's:1'`);
    sql.exec(`UPDATE session_turns SET data = '{"a":"outcome"}' WHERE id = 's:1'`);
    sql.exec(`UPDATE session_turns SET data = '{"a":0}' WHERE id = 's:0'`);
    sql.exec(`UPDATE session_turns SET turn_id = 'renamed' WHERE id = 's:0'`);
    expect(sql.prepare(`SELECT seq, revision FROM session_turns ORDER BY seq`).all()).toEqual([{ seq: 0, revision: 0 }, { seq: 1, revision: 2 }]);
    // A new row (a sequence reused after an undo) starts again from 0.
    sql.exec(`DELETE FROM session_turns WHERE id = 's:1'; INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES ('s:1', 's', 1, 't1b', '{"b":1}')`);
    expect(sql.prepare(`SELECT revision FROM session_turns WHERE id = 's:1'`).get()).toEqual({ revision: 0 });
  });
});
