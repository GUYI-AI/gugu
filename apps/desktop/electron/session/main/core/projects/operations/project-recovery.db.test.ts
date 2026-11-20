import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPath } from '@gugu/session-core/files';
import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { projects, sessions, workspaces } from '@main/db/schema';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, close: vi.fn(), bindings: [] as { projectId: string; chatId: string }[] }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw new Error('No test database'); return state.db; } }));
vi.mock('../project-manager', () => ({ projectManager: { closeProject: state.close } }));
vi.mock('../project-events', () => ({ projectEvents: { _emit: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('./project-visibility', () => ({ publishProjectVisibility: vi.fn() }));
vi.mock('./project-groups', () => ({ listProjectGroupBindings: async () => ({ success: true, data: state.bindings }) }));
vi.mock('./project-folders', () => ({ getProjectOwningAttachedFolder: async () => undefined }));
vi.mock('./create-local-project', () => ({ getLocalProjectPathStatus: async (folder: string) => ({ isDirectory: fs.statSync(folder).isDirectory(), isGitRepo: false }) }));
import { findRetainedProjectAtPath, inspectProjectRecovery, listUnavailableProjects, restoreProjectFolder } from './project-recovery';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let root: string;
let old: ReturnType<typeof canonicalPath>;
let selected: ReturnType<typeof canonicalPath>;
beforeEach(async () => {
  fixture = await openFixture('empty'); state.db = fixture.db;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-recovery-')));
  old = canonicalPath(path.join(root, 'gone')); selected = canonicalPath(path.join(root, 'selected'));
  fs.mkdirSync(selected);
  state.close.mockReset().mockResolvedValue({ success: true });
  state.bindings = [{ projectId: 'original', chatId: 'retained-group' }];
  fixture.db.insert(projects).values({ id: 'original', name: '论文伴读', path: old, repositoryWorkspaceId: 'original-root' }).run();
  fixture.db.insert(workspaces).values({ id: 'original-root', type: 'local', kind: 'project-root', path: old, key: computeWorkspaceKey(old) }).run();
  fixture.db.insert(sessions).values({ id: 'old-session', projectId: 'original', workspaceId: 'original-root' }).run();
});
afterEach(() => { vi.restoreAllMocks(); fixture.close(); state.db = undefined; fs.rmSync(root, { recursive: true, force: true }); });

describe('explicit local project recovery', () => {
  it('only lists confirmed missing folders and performs no cleanup writes', async () => {
    expect(await listUnavailableProjects()).toEqual([{ id: 'original', name: '论文伴读', path: old, chatId: 'retained-group' }]);
    expect(fixture.db.select().from(projects).all()).toHaveLength(1);
    expect(state.close).not.toHaveBeenCalled();
    fs.mkdirSync(old);
    expect(await listUnavailableProjects()).toEqual([]);
  });
  it.each(['EACCES', 'ETIMEDOUT'])('does not classify inspection failure %s as a missing folder', async code => {
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((folder: fs.PathLike, ...args: unknown[]) => {
      if (folder === old) throw Object.assign(new Error('denied'), { code });
      return Reflect.apply(stat, fs, [folder, ...args]);
    }) as typeof fs.statSync);
    expect(await listUnavailableProjects()).toEqual([]);
  });
  it('does not mark a group lost when another local folder of that group is available', async () => {
    fixture.db.insert(projects).values({ id: 'available', name: 'same group', path: selected }).run();
    state.bindings.push({ projectId: 'available', chatId: 'retained-group' });
    expect(await listUnavailableProjects()).toEqual([]);
  });
  it('changes the original project and root atomically while retaining session and group identities', async () => {
    const result = await restoreProjectFolder('original', selected);
    expect(result).toMatchObject({ success: true, data: { id: 'original', path: selected, repositoryWorkspaceId: 'original-root' } });
    expect(fixture.db.select().from(projects).all()).toHaveLength(1);
    expect(fixture.db.select().from(workspaces).where(eq(workspaces.id, 'original-root')).get()).toMatchObject({ path: selected, key: computeWorkspaceKey(selected) });
    expect(fixture.db.select().from(sessions).get()).toMatchObject({ id: 'old-session', projectId: 'original', workspaceId: 'original-root' });
    expect(state.bindings).toEqual([{ projectId: 'original', chatId: 'retained-group' }]);
  });
  it('rejects another project or workspace at the target without changing either root', async () => {
    fixture.db.insert(workspaces).values({ id: 'other-root', type: 'local', path: selected, key: computeWorkspaceKey(selected) }).run();
    expect(await inspectProjectRecovery('original', selected)).toMatchObject({ success: false, error: { type: 'path-conflict' } });
    expect(await restoreProjectFolder('original', selected)).toMatchObject({ success: false });
    expect(fixture.db.select().from(projects).get()?.path).toBe(old);
    expect(state.close).not.toHaveBeenCalled();
  });
  it('matches an original directory after cleanup, but never guesses renamed or unrelated folders', async () => {
    fs.mkdirSync(old);
    expect(await findRetainedProjectAtPath(old)).toMatchObject({ id: 'original', chatId: 'retained-group' });
    const renamed = canonicalPath(path.join(root, 'renamed'));
    fs.renameSync(old, renamed);
    expect(await findRetainedProjectAtPath(renamed)).toBeNull();
    expect(await findRetainedProjectAtPath(selected)).toBeNull();
  });
});
