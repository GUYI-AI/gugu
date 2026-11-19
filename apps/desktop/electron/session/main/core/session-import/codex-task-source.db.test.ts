import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { scanCodexTasks, verifyCodexTaskFiles } from './codex-task-source';

const roots: string[] = [];
const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-task-source-')); roots.push(root);
  await mkdir(join(root, 'sessions'));
  const path = join(root, 'state_5.sqlite');
  const db = new Database(path);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, thread_source TEXT, archived INTEGER)');
  const add = async (nativeId: string, options: { archived?: number; source?: string; compressed?: boolean; missing?: boolean; metaId?: string } = {}) => {
    const plain = join(root, 'sessions', `rollout-${nativeId}.jsonl`);
    const content = JSON.stringify({ type: 'session_meta', payload: { id: options.metaId ?? nativeId, cwd: root, source: 'cli' } }) + '\n'
      + JSON.stringify({ type: 'response_item', payload: { role: 'user', content: 'private body must not cross IPC' } }) + '\n';
    if (!options.missing) await writeFile(plain + (options.compressed ? '.zst' : ''), options.compressed ? zstdCompressSync(content) : content);
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(nativeId, 'Task', root, plain, 100, options.source ?? 'user', options.archived ?? 0);
    return plain;
  };
  return { root, path, db, add };
}

it('counts only unarchived user tasks, verifies headers and returns metadata without conversation bodies', async () => {
  const f = await fixture();
  await f.add(id); await f.add(other, { archived: 1 });
  await f.add('00000000-0000-4000-8000-000000000003', { source: 'agent' });
  f.db.close();
  const before = await readFile(f.path);
  const scan = await scanCodexTasks(f.root);
  expect(scan).toMatchObject({ status: 'ready', indexed: 1, missing: 0, invalid: 0, rows: [{ id, cwd: f.root, title: 'Task' }] });
  expect(JSON.stringify(scan)).not.toContain('private body');
  expect(await readFile(f.path)).toEqual(before);
});

it('reads Zstd rollouts and reports missing originals rather than promising index counts are importable', async () => {
  const f = await fixture();
  await f.add(id, { compressed: true }); await f.add(other, { missing: true }); f.db.close();
  const scan = await scanCodexTasks(f.root);
  expect(scan).toMatchObject({ indexed: 2, missing: 1, invalid: 0, rows: [{ id, relativePath: `sessions/rollout-${id}.jsonl.zst` }] });
  await verifyCodexTaskFiles(f.root, scan.rows);
});

it('rejects mismatched IDs and paths outside the declared sessions tree', async () => {
  const f = await fixture();
  await f.add(id, { metaId: other });
  await f.add(other);
  f.db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run('/etc/passwd', other);
  f.db.close();
  expect(await scanCodexTasks(f.root)).toMatchObject({ indexed: 2, invalid: 2, rows: [] });
});

it('rejects rollout links and makes absent/unsupported indexes explicit', async () => {
  const f = await fixture(); const path = await f.add(id); f.db.close();
  await rm(path); await symlink('/etc/passwd', path);
  expect(await scanCodexTasks(f.root)).toMatchObject({ indexed: 1, invalid: 1, rows: [] });
  await rm(f.path);
  expect(await scanCodexTasks(f.root)).toMatchObject({ status: 'unavailable', reason: 'missing-index' });
  await writeFile(f.path, 'not a database');
  expect(await scanCodexTasks(f.root)).toMatchObject({ status: 'unavailable', reason: 'unsupported-index' });
});

it('changes the revision when the source changes after scanning', async () => {
  const f = await fixture(); const path = await f.add(id); f.db.close();
  const first = (await scanCodexTasks(f.root)).rows[0];
  await utimes(path, 200, 200);
  const second = (await scanCodexTasks(f.root)).rows[0];
  expect(second.revision).not.toBe(first.revision);
  await expect(verifyCodexTaskFiles(f.root, [{ ...second, id: other }])).rejects.toThrow('metadata');
});
