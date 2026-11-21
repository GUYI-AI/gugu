import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath } from '@gugu/session-core/files';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { workspaces } from '@main/db/schema';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, close: vi.fn() }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw new Error('No test database'); return state.db; } }));
vi.mock('@main/core/workspaces/folder-runtime/folder-runtimes', () => ({ folderRuntimes: { close: state.close } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('./folder-path-status', () => ({ folderPathStatus: async (folder: string) => ({ isDirectory: fs.statSync(folder).isDirectory(), isGitRepo: false }) }));
import { findRetainedFolderAtPath, inspectFolderRecovery, listUnavailableFolders, restoreFolder } from './folder-recovery';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let root: string;
let old: ReturnType<typeof canonicalPath>;
let selected: ReturnType<typeof canonicalPath>;
function insertFolder(id: string, folder: string, chatId: string | null) {
  fixture.db.insert(workspaces).values({ id, type: 'local', kind: 'project-root', location: 'local', path: folder, key: computeWorkspaceKey(folder), chatId, sort: 1 }).run();
}
beforeEach(async () => {
  fixture = await openFixture('empty'); state.db = fixture.db;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-recovery-')));
  old = canonicalPath(path.join(root, 'gone')); selected = canonicalPath(path.join(root, 'selected'));
  fs.mkdirSync(selected);
  state.close.mockReset().mockResolvedValue({ success: true });
  insertFolder('original', old, 'retained-group');
});
afterEach(() => { vi.restoreAllMocks(); fixture.close(); state.db = undefined; fs.rmSync(root, { recursive: true, force: true }); });

describe('explicit recovery of a group folder whose directory is gone', () => {
  it('only lists confirmed missing folders and performs no writes', async () => {
    expect(await listUnavailableFolders()).toEqual([{ id: 'original', name: 'gone', path: old, chatId: 'retained-group' }]);
    expect(state.close).not.toHaveBeenCalled();
    fs.mkdirSync(old);
    expect(await listUnavailableFolders()).toEqual([]);
  });
  it.each(['EACCES', 'ETIMEDOUT'])('does not classify inspection failure %s as a missing folder', async code => {
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((folder: fs.PathLike, ...args: unknown[]) => {
      if (folder === old) throw Object.assign(new Error('denied'), { code });
      return Reflect.apply(stat, fs, [folder, ...args]);
    }) as typeof fs.statSync);
    expect(await listUnavailableFolders()).toEqual([]);
  });
  it('does not mark a group lost when another folder of that group is available here', async () => {
    insertFolder('available', selected, 'retained-group');
    expect(await listUnavailableFolders()).toEqual([]);
  });
  it('lists no folder without a group', async () => {
    fixture.db.update(workspaces).set({ chatId: null }).where(eq(workspaces.id, 'original')).run();
    expect(await listUnavailableFolders()).toEqual([]);
  });
  it('points the same folder at the chosen directory, keeping its id and group', async () => {
    const result = await restoreFolder('original', selected);
    expect(result).toMatchObject({ success: true, data: { id: 'original', path: selected, chatId: 'retained-group' } });
    expect(state.close).toHaveBeenCalledWith('original');
    expect(fixture.db.select().from(workspaces).all()).toHaveLength(1);
    expect(fixture.db.select().from(workspaces).where(eq(workspaces.id, 'original')).get()).toMatchObject({ path: selected, key: computeWorkspaceKey(selected) });
  });
  it('rejects a directory that is already another folder without changing either', async () => {
    insertFolder('other', selected, null);
    expect(await inspectFolderRecovery('original', selected)).toMatchObject({ success: false, error: { type: 'path-conflict' } });
    expect(await restoreFolder('original', selected)).toMatchObject({ success: false });
    expect(fixture.db.select().from(workspaces).where(eq(workspaces.id, 'original')).get()?.path).toBe(old);
    expect(state.close).not.toHaveBeenCalled();
  });
  it('matches the original directory once it is back, but never guesses renamed or unrelated folders', async () => {
    fs.mkdirSync(old);
    expect(await findRetainedFolderAtPath(old)).toMatchObject({ id: 'original', chatId: 'retained-group' });
    const renamed = canonicalPath(path.join(root, 'renamed'));
    fs.renameSync(old, renamed);
    expect(await findRetainedFolderAtPath(renamed)).toBeNull();
    expect(await findRetainedFolderAtPath(selected)).toBeNull();
  });
});
