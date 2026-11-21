import type { FileError, IFileSystem, IFileTree } from '@gugu/session-core/files';
import type { CanonicalPath } from '@gugu/session-core/files';
import type { Result } from '@gugu/session-shared';
import type { WorkspaceGit } from '@main/core/git/repository/directory-git';
import type { FolderSettingsProvider } from '@main/core/workspaces/folder-runtime/settings/provider';
import type { LifecycleScriptService } from './workspace-lifecycle-service';

export interface Workspace {
  readonly id: string;
  /** The working copy, in its one spelling on this machine (`@@@canonical-path`). */
  readonly path: CanonicalPath;
  readonly configPath: string;
  readonly fileSystem: IFileSystem;
  readonly fileTree: IFileTree;
  /** This workspace's Git (worktree, repository, fetch), or undefined while its directory is not a repository (@@@disk-decides-git). */
  git(): Promise<WorkspaceGit | undefined>;
  readonly settings: FolderSettingsProvider;
  readonly lifecycleService: LifecycleScriptService;
  /**
   * 打开着的文件所在的目录:界面打开文件时报进来,关掉时撤(见 IFilesRuntime.watchDirectory)。
   * 一个目录一个 watch 的平台上,这个工作区的变化流就只看这些目录 + 展开着的目录。工作区 dispose 时一并撤掉。
   */
  watchDirectory(dirPath: string): Result<() => void, FileError>;
  /**
   * 「这个工作区下面可能变过」:git status、App 这些粗粒度的整棵树订阅各重算一次(见 IWatchService.nudge)。
   * 返回有没有兑现:没有(一个根就看得到整棵树的平台)= 什么都不缺,调用方别跟着做重活。
   */
  nudge(): Promise<boolean>;
  dispose?(): void | Promise<void>;
}
