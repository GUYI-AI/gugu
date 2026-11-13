import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSessionPermissionMode } from '@gugu/session-core/acp';
import { applyMigrations, bundledMigrations } from '../../initialize';

/**
 * 0052:每条会话都记一个明确的权限档。存量里没记档的会话写进它们一直实际在用的那一档:迁移之前读取端
 * (resolveSessionPermissionMode)把缺档解成 'edit'(下面 `before` 就是迁移前那条规则),Codex 终端腿与 OpenCode
 * 的旧物化器也落在同一档。迁移之后读取端缺档即报错,所以档必须真的在记录里。
 */
const MIGRATION = bundledMigrations().find((migration) => migration.tag === '0052_session_permission_tier');
const before = (stored: { permissionMode?: string }) => stored.permissionMode ?? 'edit';

describe('0052 session permission tier', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('writes the tier an old session actually ran with, keeps recorded tiers, and is idempotent', async () => {
    fixture = await openFixture('empty', { through: '0051_session_sidebar_pin' });
    const sql = fixture.sqlite;
    sql.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, config) VALUES
        ('codex-pty', 'p1', 'T', 'codex', '{"version":"1","type":"pty","model":"gpt"}'),
        ('opencode-pty', 'p1', 'T', 'opencode', '{"version":"1","type":"pty"}'),
        ('claude-acp', 'p1', 'T', 'claude', '{"version":"1","type":"acp","agentDisplayName":"Claude 1"}'),
        ('read-only', 'p1', 'T', 'codex', '{"version":"1","type":"pty","permissionMode":"read-only"}'),
        ('full', 'p1', 'T', 'claude', '{"version":"1","type":"acp","permissionMode":"full-access"}'),
        ('no-config', 'p1', 'T', 'claude', NULL),
        ('broken', 'p1', 'T', 'claude', '{not json');
    `);
    const stored = (id: string) => (sql.prepare(`SELECT config FROM sessions WHERE id = ?`).get(id) as { config: string | null }).config;
    const effectiveBefore = Object.fromEntries(['codex-pty', 'opencode-pty', 'claude-acp', 'read-only', 'full', 'no-config']
      .map((id) => [id, before(JSON.parse(stored(id) ?? '{}'))]));

    expect(MIGRATION).toBeDefined();
    applyMigrations(sql, [MIGRATION!]);

    for (const [id, tier] of Object.entries(effectiveBefore)) {
      expect(JSON.parse(stored(id)!).permissionMode, id).toBe(tier);
    }
    // Every other key stays as it was.
    expect(JSON.parse(stored('codex-pty')!)).toEqual({ version: '1', type: 'pty', model: 'gpt', permissionMode: 'edit' });
    expect(JSON.parse(stored('claude-acp')!)).toEqual({ version: '1', type: 'acp', agentDisplayName: 'Claude 1', permissionMode: 'edit' });
    // An unreadable row is left alone; its reader reports it.
    expect(stored('broken')).toBe('{not json');

    // The one read path now answers from the record itself; before the migration it would have thrown.
    expect(resolveSessionPermissionMode(JSON.parse(stored('codex-pty')!))).toBe('edit');

    const snapshot = sql.prepare(`SELECT id, config FROM sessions ORDER BY id`).all();
    sql.exec(MIGRATION!.sql.split('--> statement-breakpoint').join(';'));
    expect(sql.prepare(`SELECT id, config FROM sessions ORDER BY id`).all()).toEqual(snapshot);
  });
});
