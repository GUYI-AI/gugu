import { mkdtemp, mkdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystem } from '@gugu/session-core/files';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { FolderRuntime } from '@main/core/workspaces/folder-runtime/folder-runtime';
import type { WorkspaceFactoryContext } from './workspace-factory';

const h = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  folder: undefined as FolderRuntime | undefined,
  factory: vi.fn(),
  create: vi.fn(),
  open: vi.fn(),
  build: vi.fn(),
}));
vi.mock('@main/db/client', () => ({ get db() { return h.db; } }));
vi.mock('@main/core/workspaces/folder-runtime/folder-runtimes', () => ({ folderRuntime: async (id: string) => { await h.open(id); return h.folder; } }));
vi.mock('@main/core/runtime/runtime-manager', () => ({ runtimeManager: {} }));
vi.mock('@main/core/sessions/session-builder', () => ({ buildSessionFromWorkspace: h.build, emitSessionProvisionProgress: vi.fn() }));
vi.mock('./workspace-factory', () => ({ createWorkspaceFactory: h.factory }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { on: () => () => undefined, emit: vi.fn() } }));
vi.mock('electron', () => ({ protocol: { isProtocolHandled: () => false, handle: vi.fn() } }));

describe('workspace operations after the host process loses its cache', () => {
  let fixture: FixtureDb;
  let root: string;
  let registry: typeof import('./workspace-registry').workspaceRegistry;
  let files: typeof import('../files/file-system/controller').workspaceFileSystemController;
  let resolve: typeof import('@main/core/workspaces/resolve-workspace').resolveWorkspace;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    fixture = await openFixture('empty');
    h.db = fixture.db;
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gugu-workspace-recovery-')));
    await writeFile(path.join(root, 'note.ts'), 'before');
    // The session row's project_id is the rollback placeholder (@@@c1-legacy-project); nothing here reads it.
    fixture.sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p', 'Placeholder', root + '-placeholder');
    fixture.sqlite.prepare("INSERT INTO workspaces (id, type, kind, location, path, key, gitless) VALUES ('ws', 'local', 'project-root', 'local', ?, ?, 1)").run(root, root);
    fixture.sqlite.prepare("INSERT INTO sessions (id, project_id, workspace_id, config) VALUES ('s', 'p', 'ws', ?)").run(JSON.stringify({ version: '1', type: 'acp', agentDisplayName: 'Recovery' }));
    h.folder = { folderId: 'ws', repoPath: root, git: { open: async () => undefined }, settings: {} } as unknown as FolderRuntime;
    h.open.mockImplementation(async () => undefined);
    h.factory.mockImplementation((id: string, context: WorkspaceFactoryContext) => async () => {
      h.create();
      return {
        workspace: {
          id, path: context.workDir, fileSystem: new FileSystem(),
          fileTree: { dispose: vi.fn() }, lifecycleService: { dispose: vi.fn() },
          git: async () => ({ worktree: { getSnapshot: async () => ({ head: 'recorded-head' }) } }),
          dispose: vi.fn(),
        },
      };
    });
    registry = (await import('./workspace-registry')).workspaceRegistry;
    resolve = (await import('@main/core/workspaces/resolve-workspace')).resolveWorkspace;
    files = (await import('../files/file-system/controller')).workspaceFileSystemController;
  });

  afterEach(async () => {
    await registry.teardownAll('detach');
    fixture.close();
    h.db = undefined;
    expect(path.dirname(root)).toBe(await realpath(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^gugu-workspace-recovery-/);
    await rm(root, { recursive: true, force: true });
  });

  it('saves through the existing file RPC immediately, opening the recorded folder on demand', async () => {
    expect(registry.get('ws')).toBeUndefined();
    const result = await files.writeFile('ws', 'note.ts', 'after restart');
    expect(result.success).toBe(true);
    expect(await readFile(path.join(root, 'note.ts'), 'utf8')).toBe('after restart');
    expect(h.open).toHaveBeenCalledWith('ws');
    expect(h.build).not.toHaveBeenCalled();
  });

  it('coalesces concurrent cold operations without retaining a reference per read or write', async () => {
    const found = await Promise.all(Array.from({ length: 8 }, () => resolve('ws')));
    expect(found.every(workspace => workspace === found[0] && workspace?.path === root)).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(1);
    const references = registry.refCount('ws');
    await resolve('ws');
    expect(registry.refCount('ws')).toBe(references);
    expect(references).toBeLessThanOrEqual(1);
  });

  it('restores through the git and preview entry points independently', async () => {
    const { gitWorktreeController } = await import('../git/worktree/controller');
    expect(await gitWorktreeController.getWorktreeSnapshot('ws')).toMatchObject({ success: true, data: { head: 'recorded-head' } });
    await registry.teardownAll('detach');
    const { createPreview, handlePreviewRequest, releasePreview } = await import('../files/preview-protocol');
    const preview = await createPreview('ws', path.join(root, 'note.ts'));
    expect(preview).not.toBeNull();
    try {
      const response = await handlePreviewRequest(new Request(preview!.url), 'pane');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('before');
    } finally {
      releasePreview(preview!.previewId);
    }
  });

  it('restores folders and directories inside them even before they have a session', async () => {
    fixture.sqlite.exec('DELETE FROM sessions');
    expect((await resolve('ws'))?.path).toBe(root);
    const attached = path.join(root, 'attached');
    await mkdir(attached);
    fixture.sqlite.prepare("INSERT INTO workspaces (id, type, kind, location, path) VALUES ('folder', 'local', 'path', 'local', ?)").run(attached);
    expect((await resolve('folder'))?.path).toBe(attached);
  });

  it('keeps a session in a folder unbound from its group', async () => {
    fixture.sqlite.exec("UPDATE workspaces SET chat_id = NULL");
    expect((await resolve('ws'))?.path).toBe(root);
  });

  it('mounts no workspace that is in no recorded folder', async () => {
    fixture.sqlite.exec("UPDATE workspaces SET kind = 'path'");
    expect(await resolve('ws')).toBeNull();
    expect(h.factory).not.toHaveBeenCalled();
  });

  it('keeps a missing workspace as not_found', async () => {
    expect(await files.writeFile('missing', 'note.ts', 'bad')).toMatchObject({ success: false, error: { type: 'not_found' } });
    expect(h.factory).not.toHaveBeenCalled();
  });

  it('does not reconstruct a directory that has really been deleted', async () => {
    await rm(path.join(root, 'note.ts'));
    await rmdir(root);
    await expect(files.writeFile('ws', 'note.ts', 'must not appear')).rejects.toThrow();
    await expect(readFile(path.join(root, 'note.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.factory).not.toHaveBeenCalled();
  });

  it('reports database read failure instead of turning it into not_found', async () => {
    const failure = vi.spyOn(fixture.db, 'select').mockImplementation(() => { throw new Error('database is unavailable'); });
    await expect(files.writeFile('ws', 'note.ts', 'bad')).rejects.toThrow('database is unavailable');
    failure.mockRestore();
    expect(await readFile(path.join(root, 'note.ts'), 'utf8')).toBe('before');
  });

  it('rejects retired remote rows before opening their recorded path on this machine', async () => {
    fixture.sqlite.exec("UPDATE workspaces SET type = 'project-ssh', location = 'remote'");
    await expect(files.writeFile('ws', 'note.ts', 'bad')).rejects.toThrow();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.factory).not.toHaveBeenCalled();
  });
});
