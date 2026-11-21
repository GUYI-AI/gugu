import type { IFileSystem } from '@gugu/session-core/files';
import type { CanonicalPath } from '@gugu/session-core/files';
import type {
  FetchError,
  GitBranchRef,
  GitHeadModel,
  GitSequences,
  IGitRuntime,
} from '@gugu/session-core/git';
import { ok, type IDisposable, type IReleasable, type Result } from '@gugu/session-shared';
import type { IExecutionContext } from '@gugu/session-core/exec';
import type { DirectoryGit } from '@main/core/git/repository/directory-git';
import { previewServerService } from '@main/core/preview-servers/preview-server-service-instance';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import type { WorkspaceProviderData } from '@shared/core/workspaces/workspace-provider-data';
import type { ProjectRemoteState as FolderRemoteState } from '@shared/projects';
import type { SessionProvider } from '@main/core/sessions/types';
import { sessionWorkspaceManager } from '@main/core/sessions/session-workspace-manager';
import type { TerminalProvider } from '@main/core/terminals/terminal-provider';
import type { FolderSettingsProvider } from './settings/provider';
import { resolveTmuxEnabled } from './settings/resolve-tmux-enabled';

export type { WorkspaceProviderData };

export type ProvisionResult = {
  sessionMount: SessionMount;
  persistData: {
    workspaceId: string;
  };
};

/** 一条会话挂载出来的运行时:它的会话 provider、终端 provider,以及所在工作区的路径与分支。 */
export interface SessionMount {
  readonly sessionId: string;
  readonly sessionBranch: string | undefined;
  readonly sourceBranch: GitBranchRef | undefined;
  readonly sessionEnvVars: Record<string, string>;
  readonly sessions: SessionProvider;
  readonly terminals: TerminalProvider;
  /** Transport the task workspace runs on; external fork capture is local-only. */
  readonly workspaceKind: 'local';
  /** Absolute workspace path the task's agents run in. */
  readonly sessionPath: string;
}

/**
 * Transport-specific dependencies of a folder runtime.
 * Pure data — no lifecycle methods.
 */
export type FolderRuntimeTransport = {
  readonly kind: string;
  readonly ctx: IExecutionContext;
  readonly fileSystem: IFileSystem;
  readonly configPath: string;
  /**
   * Transitional desktop-owned path helper. Remove once project config reads/writes
   * are served by the workspace server/core boundary instead of main-process adapters.
   */
  readonly resolvePath: (relativePath: string) => string;
  /**
   * Transitional desktop-owned path helper. Remove with resolvePath when
   * config target resolution moves behind the workspace server/core boundary.
   */
  readonly configPathForDirectory: (directoryPath: string) => string;
  /**
   * The folder's settings.
   */
  readonly settings: FolderSettingsProvider;
};

export class FolderRuntime implements IReleasable, IDisposable {
  readonly type: string;
  readonly folderId: string;
  readonly repoPath: CanonicalPath;
  readonly settings: FolderSettingsProvider;
  /** The folder's repository, read from disk when asked (@@@disk-decides-git); undefined = not one now. */
  readonly git: DirectoryGit;
  readonly fileSystem: IFileSystem;
  readonly configPath: string;

  private readonly _ctx: IExecutionContext;
  private readonly _resolvePath: (relativePath: string) => string;
  private readonly _configPathForDirectory: (directoryPath: string) => string;

  constructor(
    folderId: string,
    repoPath: CanonicalPath,
    transport: FolderRuntimeTransport,
    git: DirectoryGit,
    private readonly _gitRuntime: Pick<IGitRuntime, 'openWorktree'>,
    private readonly _releaseLeases: () => void | Promise<void>
  ) {
    this.type = transport.kind;
    this.folderId = folderId;
    this.repoPath = repoPath;
    this._ctx = transport.ctx;
    this.settings = transport.settings;
    this.fileSystem = transport.fileSystem;
    this.configPath = transport.configPath;
    this._resolvePath = transport.resolvePath;
    this._configPathForDirectory = transport.configPathForDirectory;
    this.git = git;
  }

  get ctx(): IExecutionContext {
    return this._ctx;
  }

  /**
   * Transitional desktop-owned path helper. See FolderRuntimeTransport.
   */
  resolvePath(relativePath: string): string {
    return this._resolvePath(relativePath);
  }

  /**
   * Transitional desktop-owned path helper. See FolderRuntimeTransport.
   */
  configPathForDirectory(directoryPath: string): string {
    return this._configPathForDirectory(directoryPath);
  }

  async getRemoteState(): Promise<FolderRemoteState> {
    return (await this.git.open())?.repository.getRemoteState() ?? { hasRemote: false, selectedRemoteUrl: null };
  }

  async fetch(): Promise<Result<{ sequences: GitSequences }, FetchError>> {
    // A directory without Git has nothing to fetch: an empty success.
    return (await this.git.open())?.fetch.fetch() ?? ok({ sequences: {} });
  }

  async getHead(): Promise<GitHeadModel> {
    // Non-Git directories have no HEAD.
    if (!(await this.git.open())) return { kind: 'unborn', name: '' };
    const lease = await this._gitRuntime.openWorktree(this.repoPath);
    try {
      return await lease.value.getHead();
    } finally {
      await lease.release();
    }
  }

  async release(): Promise<void> {
    const results = await Promise.allSettled([
      workspaceRegistry.releaseLeasesForFolder(this.folderId),
      this._releaseLeases(),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async dispose(): Promise<void> {
    try {
      // 与 spawn 同一个答案(resolveTmuxEnabled):跑进 tmux 的会话退出时 detach,❌ 按项目存的种子判成 terminate。
      const mode = (await resolveTmuxEnabled(this.settings, this.folderId)) ? 'detach' : 'terminate';
      await sessionWorkspaceManager.teardownAllForFolder(this.folderId, mode);
      await workspaceRegistry.teardownAllForFolder(this.folderId, mode);
      await previewServerService.stopForFolder(this.folderId);
    } finally {
      await this.release();
    }
  }
}
