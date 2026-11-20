import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  byPath: vi.fn(), attached: vi.fn(), create: vi.fn(), open: vi.fn(),
}));
vi.mock('../projects/operations/getProjects', () => ({ getLocalProjectByPath: host.byPath }));
vi.mock('../projects/operations/project-folders', () => ({ getProjectOwningAttachedFolder: host.attached }));
vi.mock('../projects/operations/create-local-project', () => ({ createLocalProject: host.create }));
vi.mock('../projects/operations/openProject', () => ({ openProject: host.open }));
import { importCodexProjects, scanCodexProjects } from './projects';

let root: string;
let sourceRoot: string;
let database: DatabaseSync;
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

beforeEach(async () => {
  vi.clearAllMocks();
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex-project-import-')));
  sourceRoot = join(root, '.codex');
  await mkdir(sourceRoot);
  database = new DatabaseSync(join(sourceRoot, 'state_5.sqlite'));
  database.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
    CREATE TABLE project_roots (project_id TEXT NOT NULL REFERENCES projects(id),
      position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY(project_id,position));`);
  host.byPath.mockResolvedValue(undefined);
  host.attached.mockResolvedValue(undefined);
  host.create.mockImplementation(async ({ path, name }: { path: string; name: string }) => ({
    success: true, data: { id: `target:${path}`, path, name },
  }));
  host.open.mockResolvedValue({ success: true, data: {} });
});
afterEach(async () => {
  database.close();
  await rm(root, { recursive: true, force: true });
});

async function project(id: string, directories: string[], name = id) {
  database.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run(id, name, '{}', 0, 1, 2);
  for (const [index, directory] of directories.entries()) {
    database.prepare('INSERT INTO project_roots VALUES (?, ?, ?)').run(id, index, directory);
  }
}
async function folder(name: string) {
  const directory = join(root, name);
  await mkdir(directory);
  return directory;
}
const scan = () => scanCodexProjects({ sourceRoot });

describe('Codex project source', () => {
  it('flattens three projects into four unique original folders and ignores path trust entries', async () => {
    const directories = await Promise.all(['one', 'two', 'three', 'four'].map(folder));
    await project('p1', directories.slice(0, 2));
    await project('p2', [directories[2]]);
    await project('p3', [directories[3]]);
    await writeFile(join(sourceRoot, 'config.toml'), '[projects."/not-a-project"]\ntrust_level="trusted"');
    const before = await digest(join(sourceRoot, 'state_5.sqlite'));
    const result = await scan();
    expect(result.sourceProjectCount).toBe(3);
    expect(result.count).toBe(4);
    expect(result.items.map(item => item.directory)).toEqual(directories);
    expect(result.items.every(item => item.status === 'ready')).toBe(true);
    expect(result.items[0].sources[0]).toMatchObject({ projectId: 'p1', rootPosition: 0 });
    expect(result.items[1].sources[0]).toMatchObject({ projectId: 'p1', rootPosition: 1 });
    expect(await digest(join(sourceRoot, 'state_5.sqlite'))).toBe(before);
    expect(host.create).not.toHaveBeenCalled();
  });

  it('deduplicates aliases and preserves all source relationships', async () => {
    const directory = await folder('original');
    const alias = join(root, 'alias');
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await project('a', [directory, `${directory}/`]);
    await project('b', [alias]);
    const first = await scan();
    const second = await scan();
    expect(first.items).toHaveLength(1);
    expect(first.items[0].sources).toHaveLength(3);
    expect(second.items).toEqual(first.items);
    database.prepare('UPDATE projects SET name=? WHERE id=?').run('Renamed', 'a');
    const renamed = (await scan()).items[0];
    expect(renamed.localSourceId).toBe(first.items[0].localSourceId);
    expect(renamed.sourceFingerprint).not.toBe(first.items[0].sourceFingerprint);
  });

  it('uses a consistent read-only WAL snapshot including committed rows', async () => {
    database.exec('PRAGMA journal_mode=WAL');
    await project('wal', [await folder('wal')]);
    const files = ['state_5.sqlite', 'state_5.sqlite-wal'];
    const before = await Promise.all(files.map(name => digest(join(sourceRoot, name))));
    expect((await scan()).items).toHaveLength(1);
    expect(await Promise.all(files.map(name => digest(join(sourceRoot, name))))).toEqual(before);
  });

  it('reports missing roots without creating an empty directory', async () => {
    const missing = join(root, 'absent');
    await project('missing', [missing]);
    const result = await scan();
    expect(result.items[0].status).toBe('missing-directory');
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('distinguishes a missing source from an unreadable source schema', async () => {
    expect(await scanCodexProjects({ sourceRoot: join(root, 'absent-source') }))
      .toMatchObject({ sourceStatus: 'missing', sourceProjectCount: 0, items: [] });
    database.exec('DROP TABLE project_roots');
    await expect(scan()).rejects.toThrow('Codex project source could not be read');
  });

  it('rejects relative source roots in the database', async () => {
    await project('relative', ['relative']);
    await expect(scan()).rejects.toThrow('Invalid Codex project source');
  });

  it('reports a busy source without leaking a raw SQLite error or changing it', async () => {
    await project('locked', [await folder('locked')]);
    const before = await digest(join(sourceRoot, 'state_5.sqlite'));
    database.exec('BEGIN EXCLUSIVE');
    try { await expect(scan()).rejects.toThrow('Codex project source is busy'); }
    finally { database.exec('ROLLBACK'); }
    expect(await digest(join(sourceRoot, 'state_5.sqlite'))).toBe(before);
  });

  it('propagates pre-cancellation and cancels a waiting SQLite child', async () => {
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled by caller'));
    await expect(scanCodexProjects({ sourceRoot, signal: cancelled.signal })).rejects.toThrow('cancelled by caller');
    database.exec('BEGIN EXCLUSIVE');
    const pending = new AbortController();
    const result = scanCodexProjects({ sourceRoot, signal: pending.signal });
    setTimeout(() => pending.abort(new Error('cancelled child')), 30);
    try { await expect(result).rejects.toThrow('cancelled child'); }
    finally { database.exec('ROLLBACK'); }
  });
});

describe('Codex project import', () => {
  it('registers the exact original directory and verifies its real open path', async () => {
    const directory = await folder('original files');
    await writeFile(join(directory, 'README.md'), 'original');
    await project('p', [directory], 'Source name');
    const items = (await scan()).items;
    const before = await digest(join(sourceRoot, 'state_5.sqlite'));
    const [result] = await importCodexProjects(items, { sourceRoot });
    expect(result).toMatchObject({ status: 'imported', target: { directory } });
    expect(host.create).toHaveBeenCalledWith({
      path: directory, name: 'Source name', allowNonGit: true, exactPath: true,
      reuseExisting: true, automatic: true, createDirectory: false, initGitRepository: false,
    });
    expect(host.open).toHaveBeenCalledWith(result.target?.projectId);
    expect(await readFile(join(directory, 'README.md'), 'utf8')).toBe('original');
    expect(await digest(join(sourceRoot, 'state_5.sqlite'))).toBe(before);
  });

  it('reuses existing project and attached-folder ownership without registering duplicates', async () => {
    const directory = await folder('attached');
    await project('p', [directory]);
    const items = (await scan()).items;
    host.byPath.mockResolvedValue({ id: 'existing', path: directory });
    expect((await importCodexProjects(items, { sourceRoot }))[0].status).toBe('exists');
    host.attached.mockResolvedValue({ id: 'owner', path: root });
    expect((await importCodexProjects(items, { sourceRoot }))[0])
      .toMatchObject({ status: 'exists', target: { projectId: 'owner', directory } });
    expect(host.create).not.toHaveBeenCalled();
    expect(host.open).toHaveBeenLastCalledWith('owner');
  });

  it('never opens or restores an archived target, including an automatic-create race', async () => {
    const directory = await folder('archived');
    await project('p', [directory]);
    const items = (await scan()).items;
    host.byPath.mockResolvedValue({ id: 'archived', path: directory, archivedAt: '2026-01-01' });
    expect((await importCodexProjects(items, { sourceRoot }))[0])
      .toMatchObject({ status: 'skipped', reason: 'archived-target' });
    expect(host.create).not.toHaveBeenCalled();
    host.byPath.mockResolvedValue(undefined);
    host.create.mockResolvedValue({ success: true, data: { id: 'archived', path: directory, archivedAt: '2026-01-01' } });
    expect((await importCodexProjects(items, { sourceRoot }))[0].reason).toBe('archived-target');
    expect(host.open).not.toHaveBeenCalled();
  });

  it('reports create failures without claiming a target was opened', async () => {
    await project('p', [await folder('create-failure')]);
    host.create.mockResolvedValue({ success: false, error: { type: 'init-failed' } });
    expect((await importCodexProjects((await scan()).items, { sourceRoot }))[0])
      .toMatchObject({ status: 'failed', reason: 'create-failed' });
    expect(host.open).not.toHaveBeenCalled();
  });

  it('reports target exceptions per item without exposing the raw message', async () => {
    await project('p', await Promise.all(['failed', 'good'].map(folder)));
    host.byPath.mockRejectedValueOnce(new Error('private target details'));
    const results = await importCodexProjects((await scan()).items, { sourceRoot });
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'target-unavailable' });
    expect(results[1].status).toBe('imported');
    expect(JSON.stringify(results)).not.toContain('private target details');
  });

  it('rejects unknown source IDs and does not echo caller-supplied paths', async () => {
    const [result] = await importCodexProjects([{
      localSourceId: 'unknown', sourceFingerprint: 'unknown', directory: '/untrusted',
    } as { localSourceId: string; sourceFingerprint: string }], { sourceRoot });
    expect(result).toEqual({ localSourceId: 'unknown', sourceFingerprint: 'unknown', type: 'project', scope: 'project',
      status: 'conflict', reason: 'source-changed' });
    expect(host.create).not.toHaveBeenCalled();
  });

  it('revalidates source fingerprints and missing directories before any target writes', async () => {
    const directory = await folder('removed');
    await project('p', [directory]);
    const items = (await scan()).items;
    database.prepare('UPDATE projects SET updated_at_ms=updated_at_ms+1').run();
    expect((await importCodexProjects(items, { sourceRoot }))[0].reason).toBe('source-changed');
    const current = (await scan()).items;
    await rm(directory, { recursive: true });
    expect((await importCodexProjects(current, { sourceRoot }))[0].reason).toBe('missing-directory');
    expect(host.create).not.toHaveBeenCalled();
    expect(host.open).not.toHaveBeenCalled();
  });

  it('serializes repeated/concurrent selections and returns existing rows on retry', async () => {
    const directory = await folder('once');
    await project('p', [directory]);
    const items = (await scan()).items;
    host.create.mockImplementation(async () => {
      const target = { id: 'one-target', path: directory };
      host.byPath.mockResolvedValue(target);
      return { success: true, data: target };
    });
    const results = (await Promise.all([importCodexProjects(items, { sourceRoot }), importCodexProjects(items, { sourceRoot })])).flat();
    expect(results.map(result => result.status).sort()).toEqual(['exists', 'imported']);
    expect(host.create).toHaveBeenCalledTimes(1);
  });

  it('keeps open failures explicit and retries the mount of a registered project', async () => {
    const directory = await folder('mount');
    await project('p', [directory]);
    const items = (await scan()).items;
    host.open.mockResolvedValue({ success: false, error: { type: 'path-access-blocked' } });
    const [result] = await importCodexProjects(items, { sourceRoot });
    expect(result).toMatchObject({ status: 'failed', reason: 'open-failed', target: { directory } });
    host.byPath.mockResolvedValue({ id: result.target?.projectId, path: directory });
    host.open.mockResolvedValue({ success: true });
    expect((await importCodexProjects(items, { sourceRoot }))[0].status).toBe('exists');
    expect(host.create).toHaveBeenCalledTimes(1);
  });

  it('finishes a committed mount then propagates cancellation before the next item', async () => {
    const directories = await Promise.all(['first', 'second'].map(folder));
    await project('p', directories);
    const items = (await scan()).items;
    const controller = new AbortController();
    host.create.mockImplementation(async ({ path }: { path: string }) => {
      controller.abort(new Error('stop after commit'));
      return { success: true, data: { id: 'committed', path } };
    });
    await expect(importCodexProjects(items, { sourceRoot, signal: controller.signal })).rejects.toThrow('stop after commit');
    expect(host.open).toHaveBeenCalledTimes(1);
    expect(host.create).toHaveBeenCalledTimes(1);
  });
});
