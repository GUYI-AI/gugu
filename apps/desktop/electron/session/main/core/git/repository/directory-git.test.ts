import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystem } from '@gugu/session-core/files';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderSettingsProvider } from '@main/core/workspaces/folder-runtime/settings/provider';
import { DirectoryGit, workspaceGit } from './directory-git';

vi.mock('./fetch-service', () => ({
  GitRepositoryFetchService: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-git-'));
  tempDirs.push(root);
  const releaseRepo = vi.fn();
  const stopUpdates = vi.fn();
  const openRepository = vi.fn(async () => ({ value: { repo: root }, release: releaseRepo }));
  const onOpen = vi.fn(() => stopUpdates);
  const git = new DirectoryGit(
    root,
    path.join(root, '.git'),
    { openRepository } as never,
    new FileSystem(),
    {} as FolderSettingsProvider,
    onOpen
  );
  return { root, git, openRepository, releaseRepo, onOpen, stopUpdates };
}

describe('DirectoryGit (@@@disk-decides-git)', () => {
  it('a folder that becomes a repository has Git on the next read, opened once', async () => {
    const f = await fixture();
    expect(await f.git.open()).toBeUndefined();
    expect(f.openRepository).not.toHaveBeenCalled();

    await fs.mkdir(path.join(f.root, '.git'));
    const first = await f.git.open();
    expect(first).toBeDefined();
    expect(await f.git.open()).toBe(first);
    expect(await Promise.all([f.git.open(), f.git.open()])).toEqual([first, first]);
    expect(f.openRepository).toHaveBeenCalledTimes(1);
    expect(f.onOpen).toHaveBeenCalledTimes(1);
  });

  it('a repository whose .git goes away stops having Git, and its lease is released', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, '.git'));
    expect(await f.git.open()).toBeDefined();
    await fs.rm(path.join(f.root, '.git'), { recursive: true });
    expect(await f.git.open()).toBeUndefined();
    expect(f.stopUpdates).toHaveBeenCalledTimes(1);
    expect(f.releaseRepo).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when .git cannot be read', async () => {
    const f = await fixture();
    const git = new DirectoryGit(f.root, path.join(f.root, '.git'), { openRepository: f.openRepository } as never, {
      stat: async () => ({ success: false, error: { type: 'fs-error', path: f.root, code: 'EACCES', message: 'Permission denied' } }),
    } as never, {} as FolderSettingsProvider);
    await expect(git.open()).rejects.toThrow('Permission denied');
  });
});

describe('workspaceGit', () => {
  it('opens the worktree once on a read that finds a repository, and retries a failed open', async () => {
    const f = await fixture();
    const releaseWorktree = vi.fn();
    const stopFeed = vi.fn();
    const openWorktree = vi
      .fn()
      .mockRejectedValueOnce(new Error('fatal: bad object HEAD'))
      .mockResolvedValue({ value: { worktree: true }, release: releaseWorktree });
    const ws = workspaceGit(f.git, f.root, { openWorktree }, () => stopFeed);

    expect(await ws.read()).toBeUndefined();
    expect(openWorktree).not.toHaveBeenCalled();

    await fs.mkdir(path.join(f.root, '.git'));
    await expect(ws.read()).rejects.toThrow('fatal: bad object HEAD');
    const read = await ws.read();
    expect(read?.worktree).toEqual({ worktree: true });
    await ws.read();
    expect(openWorktree).toHaveBeenCalledTimes(2);

    await fs.rm(path.join(f.root, '.git'), { recursive: true });
    expect(await ws.read()).toBeUndefined();
    expect(stopFeed).toHaveBeenCalledTimes(1);
    expect(releaseWorktree).toHaveBeenCalledTimes(1);
  });
});
