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
import type { ProjectRemoteState } from '@shared/projects';
import type { SessionProvider } from '../sessions/types';
import { sessionWorkspaceManager } from '../sessions/session-workspace-manager';
import type { TerminalProvider } from '../terminals/terminal-provider';
import type { ProjectSettingsProvider } from './settings/provider';
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
 * Transport-specific dependencies of a project provider.
 * Pure data — no lifecycle methods.
 */
export type ProjectProviderTransport = {
  readonly kind: string;
  readonly ctx: IExecutionContext;
  readonly fileSystem: IFileSystem;
  readonly projectConfigPath: string;
  /**
   * Transitional desktop-owned path helper. Remove once project config reads/writes
   * are served by the workspace server/core boundary instead of main-process adapters.
   */
  readonly resolveProjectPath: (relativePath: string) => string;
  /**
   * Transitional desktop-owned path helper. Remove with resolveProjectPath when
   * config target resolution moves behind the workspace server/core boundary.
   */
  readonly configPathForDirectory: (directoryPath: string) => string;
  /**
   * Project settings for this transport.
   */
  readonly settings: ProjectSettingsProvider;
};

export class ProjectProvider implements IReleasable, IDisposable {
  readonly type: string;
  readonly projectId: string;
  readonly repoPath: CanonicalPath;
  readonly settings: ProjectSettingsProvider;
  /** The project directory's repository, read from disk when asked (@@@disk-decides-git); undefined = not one now. */
  readonly git: DirectoryGit;
  readonly fileSystem: IFileSystem;
  readonly projectConfigPath: string;

  private readonly _ctx: IExecutionContext;
  private readonly _resolveProjectPath: (relativePath: string) => string;
  private readonly _configPathForDirectory: (directoryPath: string) => string;

  constructor(
    projectId: string,
    repoPath: CanonicalPath,
    transport: ProjectProviderTransport,
    git: DirectoryGit,
    private readonly _gitRuntime: Pick<IGitRuntime, 'openWorktree'>,
    private readonly _releaseProjectLeases: () => void | Promise<void>
  ) {
    this.type = transport.kind;
    this.projectId = projectId;
    this.repoPath = repoPath;
    this._ctx = transport.ctx;
    this.settings = transport.settings;
    this.fileSystem = transport.fileSystem;
    this.projectConfigPath = transport.projectConfigPath;
    this._resolveProjectPath = transport.resolveProjectPath;
    this._configPathForDirectory = transport.configPathForDirectory;
    this.git = git;
  }

  get ctx(): IExecutionContext {
    return this._ctx;
  }

  /**
   * Transitional desktop-owned path helper. See ProjectProviderTransport.
   */
  resolveProjectPath(relativePath: string): string {
    return this._resolveProjectPath(relativePath);
  }

  /**
   * Transitional desktop-owned path helper. See ProjectProviderTransport.
   */
  configPathForDirectory(directoryPath: string): string {
    return this._configPathForDirectory(directoryPath);
  }

  async getRemoteState(): Promise<ProjectRemoteState> {
    return (await this.git.open())?.repository.getRemoteState() ?? { hasRemote: false, selectedRemoteUrl: null };
  }

  async fetch(): Promise<Result<{ sequences: GitSequences }, FetchError>> {
    // A directory without Git has nothing to fetch: an empty success.
    return (await this.git.open())?.fetch.fetch() ?? ok({ sequences: {} });
  }

  async getProjectRootHead(): Promise<GitHeadModel> {
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
      workspaceRegistry.releaseLeasesForProject(this.projectId),
      this._releaseProjectLeases(),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  async dispose(): Promise<void> {
    try {
      // 与 spawn 同一个答案(resolveTmuxEnabled):跑进 tmux 的会话退出时 detach,❌ 按项目存的种子判成 terminate。
      const mode = (await resolveTmuxEnabled(this.settings, this.projectId)) ? 'detach' : 'terminate';
      await sessionWorkspaceManager.teardownAllForProject(this.projectId, mode);
      await workspaceRegistry.teardownAllForProject(this.projectId, mode);
      await previewServerService.stopForProject(this.projectId);
    } finally {
      await this.release();
    }
  }
}
