import { chmod, mkdtemp, mkdir, writeFile, rm, readFile, readdir, symlink, utimes } from 'node:fs/promises';
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

it('stops cancelled copied-file validation before reading another rollout', async () => {
  const f = await fixture(); const path = await f.add(id); f.db.close();
  const scan = await scanCodexTasks(f.root);
  await rm(path);
  const controller = new AbortController();
  const reason = new Error('Import cancelled'); controller.abort(reason);
  // Cancellation must win over the now-missing file; no continuation may be bound.
  await expect(verifyCodexTaskFiles(f.root, scan.rows, controller.signal)).rejects.toBe(reason);
});

it.each(['sessions', 'archived_sessions'])('collects a paginated ancestor in %s as context, not a visible task', async folder => {
  const f = await fixture();
  const primary = await f.add(id);
  const parent = join(f.root, folder, `rollout-${other}.jsonl`);
  await mkdir(join(f.root, folder), { recursive: true });
  const ancestor = JSON.stringify({ type: 'session_meta', payload: { id: other, cwd: f.root, history_mode: 'paginated', history_base: null } }) + '\n';
  await writeFile(parent, ancestor);
  await writeFile(primary, JSON.stringify({ type: 'session_meta', payload: { id, cwd: f.root, history_mode: 'paginated',
    history_base: { thread_id: other, end_ordinal_exclusive: 1, end_byte_offset: Buffer.byteLength(ancestor) } } }) + '\n');
  f.db.close();
  const scan = await scanCodexTasks(f.root);
  expect(scan).toMatchObject({ indexed: 1, invalid: 0, rows: [{ id, files: [{ nativeId: id }, { nativeId: other, relativePath: `${folder}/rollout-${other}.jsonl` }] }] });
  await verifyCodexTaskFiles(f.root, scan.rows);
  await rm(parent);
  expect(await scanCodexTasks(f.root)).toMatchObject({ indexed: 1, rows: [], blocked: [{ id, reason: 'missing-history' }] });
});

it('refuses cyclic lineage and detects an altered ancestor in the scan revision', async () => {
  const f = await fixture(); const primary = await f.add(id); f.db.close();
  const parent = join(f.root, 'sessions', `rollout-${other}.jsonl`);
  const meta = (nativeId: string, base: string | null) => JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: f.root,
    history_mode: 'paginated', history_base: base ? { thread_id: base, end_ordinal_exclusive: 1, end_byte_offset: 0 } : null } }) + '\n';
  await writeFile(primary, meta(id, other)); await writeFile(parent, meta(other, null));
  const first = await scanCodexTasks(f.root);
  expect(first.rows).toHaveLength(1);
  await utimes(parent, 200, 200);
  expect((await scanCodexTasks(f.root)).rows[0].revision).not.toBe(first.rows[0].revision);
  await writeFile(parent, meta(other, id));
  expect(await scanCodexTasks(f.root)).toMatchObject({ invalid: 1, rows: [], blocked: [{ id, reason: 'invalid-history' }] });
});

// #3334: a normal Codex shutdown removes these sidecars. Scanning must not recreate them.
it.skipIf(process.platform === 'win32')('reads a closed WAL index in a read-only directory without creating sidecars', async () => {
  const f = await fixture();
  f.db.pragma('journal_mode = WAL');
  await f.add(id); f.db.close();
  await chmod(f.root, 0o500);
  try {
    const before = await readFile(f.path);
    const names = await readdir(f.root);
    expect(names).not.toContain('state_5.sqlite-wal');
    expect(names).not.toContain('state_5.sqlite-shm');
    expect(await scanCodexTasks(f.root)).toMatchObject({ status: 'ready', indexed: 1, rows: [{ id }] });
    expect(await readFile(f.path)).toEqual(before);
    expect(await readdir(f.root)).toEqual(names);
  } finally { await chmod(f.root, 0o700); }
});

it('includes committed live WAL rows instead of treating the main file as immutable', async () => {
  const f = await fixture();
  try {
    f.db.pragma('journal_mode = WAL');
    f.db.pragma('wal_checkpoint(TRUNCATE)');
    await f.add(id);
    const before = await readFile(f.path);
    const wal = await readFile(`${f.path}-wal`);
    expect(wal.length).toBeGreaterThan(0);
    expect(await scanCodexTasks(f.root)).toMatchObject({ status: 'ready', indexed: 1, rows: [{ id }] });
    expect(await readFile(f.path)).toEqual(before);
    expect(await readFile(`${f.path}-wal`)).toEqual(wal);
  } finally { f.db.close(); }
});

it('reports an absent Codex home and an unsupported threads schema separately', async () => {
  const f = await fixture(); f.db.exec('DROP TABLE threads'); f.db.close();
  expect(await scanCodexTasks(join(f.root, 'not-installed'))).toMatchObject({ status: 'unavailable', reason: 'missing-index' });
  expect(await scanCodexTasks(f.root)).toMatchObject({ status: 'unavailable', reason: 'unsupported-index' });
});
