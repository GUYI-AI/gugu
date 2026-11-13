// @@@canonical-path 旧记录迁移:别名写法的行改成规范写法,先记后改、幂等、撞车不动;会话的「输出」与 Claude 的会话记录跟着走。
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import type { CanonicalPath } from '@gugu/session-shared/canonical-path';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { claudeProjectKey, copyClaudeHistoryForMovedFolders, migrateCanonicalPaths, migrateSessionOutputPaths } from './migrate-canonical-paths';
import { KV } from '@main/db/kv';

describe('canonical-path migration', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let base: string;
  let real: string;
  let alias: string;
  const rows = (table: 'projects' | 'workspaces') =>
    Object.fromEntries(fixture.sqlite.prepare(`SELECT id, path${table === 'workspaces' ? ', key' : ''} FROM ${table} ORDER BY id`).all().map((row: any) => [row.id, row]));

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    base = realpathSync(mkdtempSync(join(tmpdir(), 'gugu-canonical-')));
    // A server after the 11-03 move: the data under `account`, the link `accounts/u1` → `../account` kept for old paths.
    real = join(base, 'account', 'data', 'task-home');
    mkdirSync(real, { recursive: true });
    mkdirSync(join(base, 'accounts'));
    symlinkSync('../account', join(base, 'accounts', 'u1'));
    alias = join(base, 'accounts', 'u1', 'data', 'task-home');
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('00000000-0000-4000-8000-000000000001', '任务工作区', '${alias}');
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-home', 'project-root', 'local', 'local', '${alias}', 'old-key');
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-real', 'path', 'local', 'local', '${join(base, 'account', 'data')}', '${computeWorkspaceKey(join(base, 'account', 'data') as CanonicalPath)}');
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-remote', 'path', 'remote', 'local', '/elsewhere/accounts/u1', 'remote-key');
    `);
  });
  afterEach(() => {
    fixture.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('rewrites an alias row in its one spelling, with its key; a canonical row and another machine’s row stay', () => {
    const record = join(base, 'record.json');
    const { moved, conflicts } = migrateCanonicalPaths(record);
    expect(conflicts).toEqual([]);
    expect(moved.map((m) => [m.table, m.id, m.from, m.to])).toEqual([
      ['projects', '00000000-0000-4000-8000-000000000001', alias, real],
      ['workspaces', 'ws-home', alias, real],
    ]);
    expect(rows('projects')['00000000-0000-4000-8000-000000000001'].path).toBe(real);
    expect(rows('workspaces')['ws-home']).toMatchObject({ path: real, key: computeWorkspaceKey(real as CanonicalPath) });
    expect(rows('workspaces')['ws-real'].path).toBe(join(base, 'account', 'data'));
    expect(rows('workspaces')['ws-remote'].path).toBe('/elsewhere/accounts/u1');
    // Recorded before it changed: what each row was.
    expect(JSON.parse(readFileSync(record, 'utf8')).moved.map((m: { from: string }) => m.from)).toEqual([alias, alias]);
  });

  it('is idempotent: run again, nothing to do', () => {
    const record = join(base, 'record.json');
    migrateCanonicalPaths(record);
    expect(migrateCanonicalPaths(record)).toEqual({ moved: [], conflicts: [] });
  });

  it('a row whose spelling another row already holds is left as it was, and said', () => {
    fixture.sqlite.exec(`INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-dupe', 'path', 'local', 'local', '${real}', '${computeWorkspaceKey(real as CanonicalPath)}');`);
    const { moved, conflicts } = migrateCanonicalPaths(join(base, 'record.json'));
    expect(conflicts).toEqual([{ table: 'workspaces', id: 'ws-home', path: alias }]);
    expect(moved.map((m) => m.id)).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(rows('workspaces')['ws-home'].path).toBe(alias);
  });

  it('what a session opened follows its folder', async () => {
    const store = new KV<Record<string, { kind: 'file'; path: string }[]>>('session-outputs');
    await store.setOrThrow('s1', [{ kind: 'file', path: join(alias, 'ml-notes', 'a.md') }, { kind: 'file', path: '/other/b.md' }]);
    const { moved } = migrateCanonicalPaths(join(base, 'record.json'));
    expect(await migrateSessionOutputPaths(moved)).toBe(1);
    expect(await store.get('s1')).toEqual([{ kind: 'file', path: join(real, 'ml-notes', 'a.md') }, { kind: 'file', path: '/other/b.md' }]);
  });

  it('Claude’s history of the folder is copied under its new spelling, never over a file there; folders counted before and after', async () => {
    const root = join(base, 'claude-root');
    const oldDir = join(root, 'projects', claudeProjectKey(alias));
    const newDir = join(root, 'projects', claudeProjectKey(real));
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, 'session-1.jsonl'), 'old 1');
    writeFileSync(join(oldDir, 'session-2.jsonl'), 'old 2');
    writeFileSync(join(newDir, 'session-2.jsonl'), 'already here');
    const { moved } = migrateCanonicalPaths(join(base, 'record.json'));
    const report = await copyClaudeHistoryForMovedFolders([root, join(base, 'no-such-root')], moved);
    expect(report).toEqual([{ root, before: 2, after: 2, copied: 1 }]);
    expect(readFileSync(join(newDir, 'session-1.jsonl'), 'utf8')).toBe('old 1');
    expect(readFileSync(join(newDir, 'session-2.jsonl'), 'utf8')).toBe('already here');
    // The old folder stays: copied, never moved.
    expect(readdirSync(oldDir).sort()).toEqual(['session-1.jsonl', 'session-2.jsonl']);
  });
});
