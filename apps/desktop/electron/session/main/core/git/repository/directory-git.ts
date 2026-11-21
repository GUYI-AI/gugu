import { isFileNotFoundError, type IFileSystem } from '@gugu/session-core/files';
import type { IGitRepository, IGitRuntime, IGitWorktree } from '@gugu/session-core/git';
import type { Lease } from '@gugu/session-shared';
import type { FolderSettingsProvider } from '@main/core/workspaces/folder-runtime/settings/provider';
import { GitRepositoryFetchService } from './fetch-service';
import { GitRepositoryService } from './service';

export type GitUnit = { readonly repository: GitRepositoryService; readonly fetch: GitRepositoryFetchService };
export type WorkspaceGit = GitUnit & { readonly worktree: IGitWorktree };

/**
 * @@@disk-decides-git - "Is this directory a Git repository" is read from the disk each time someone asks, never decided
 * once: a folder that becomes a repository while a session runs (`git init`) has Git on the next read, and one whose
 * `.git` goes away stops having it. While `.git` is there, the repository (lease, service, fetch, update feed) is opened
 * once and kept — the three always appear and go together.
 */
export class DirectoryGit {
  private held: { unit: GitUnit; release: () => Promise<void> } | undefined;
  private pending: Promise<GitUnit | undefined> | undefined;

  constructor(
    private readonly path: string,
    private readonly gitDir: string,
    private readonly git: Pick<IGitRuntime, 'openRepository'>,
    private readonly files: Pick<IFileSystem, 'stat'>,
    private readonly settings: FolderSettingsProvider,
    /** Runs when the repository opens; what it returns runs when it closes. */
    private readonly onOpen: (repository: IGitRepository) => (() => void) | void = () => {}
  ) {}

  /** The repository, or undefined when the directory is not one right now. */
  open(): Promise<GitUnit | undefined> {
    this.pending ??= this.read().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async read(): Promise<GitUnit | undefined> {
    if (!(await directoryHasGit(this.path, this.gitDir, this.files))) {
      await this.close();
      return undefined;
    }
    if (this.held) return this.held.unit;
    const lease = await this.git.openRepository(this.path);
    const repository = new GitRepositoryService(lease.value, this.settings);
    const fetch = new GitRepositoryFetchService(repository, () => repository.getBaseRemote());
    fetch.start();
    const stopUpdates = this.onOpen(lease.value);
    this.held = {
      unit: { repository, fetch },
      release: async () => {
        stopUpdates?.();
        fetch.stop();
        await lease.release();
      },
    };
    return this.held.unit;
  }

  async close(): Promise<void> {
    const held = this.held;
    this.held = undefined;
    await held?.release();
  }
}

/**
 * A workspace's Git: its own worktree on top of its directory's repository, opened on the first read that finds one.
 * `onWorktree` wires the worktree's update feed; what it returns runs when the worktree closes.
 */
export function workspaceGit(
  directory: DirectoryGit,
  workDir: string,
  git: Pick<IGitRuntime, 'openWorktree'>,
  onWorktree: (worktree: IGitWorktree) => () => void
) {
  let worktree: Promise<{ lease: Lease<IGitWorktree>; stop: () => void }> | undefined;
  const close = async () => {
    const opened = worktree;
    worktree = undefined;
    const held = await opened?.catch(() => undefined);
    held?.stop();
    await held?.lease.release();
  };
  return {
    async read(): Promise<WorkspaceGit | undefined> {
      const unit = await directory.open();
      if (!unit) {
        await close();
        return undefined;
      }
      worktree ??= git.openWorktree(workDir).then((lease) => ({ lease, stop: onWorktree(lease.value) }));
      // A failed open is not kept: the next read tries again, and this one reports git's own error.
      const held = await worktree.catch((error: unknown) => {
        worktree = undefined;
        throw error;
      });
      return { ...unit, worktree: held.lease.value };
    },
    close,
  };
}

async function directoryHasGit(path: string, gitDir: string, files: Pick<IFileSystem, 'stat'>): Promise<boolean> {
  const metadata = await files.stat(gitDir);
  // A .git file is valid for linked worktrees. Existing but damaged metadata still goes through Git and reports its
  // error instead of silently degrading.
  if (metadata.success) return true;
  if (!isFileNotFoundError(metadata.error)) throw new Error(metadata.error.message);
  const directory = await files.stat(path);
  if (!directory.success) throw new Error(directory.error.message);
  if (directory.data.type !== 'directory') throw new Error(`Not a directory: ${path}`);
  return false;
}
