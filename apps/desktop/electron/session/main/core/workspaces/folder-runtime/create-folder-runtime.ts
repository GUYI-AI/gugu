import type { IFileSystem } from '@gugu/session-core/files';
import type { CanonicalPath } from '@gugu/session-core/files';
import type { IGitRepository, IGitRuntime } from '@gugu/session-core/git';
import { err, ok, type Lease, type Result } from '@gugu/session-shared';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { GitRepositoryFetchService } from '@main/core/git/repository/fetch-service';
import { GitRepositoryService } from '@main/core/git/repository/service';
import { folderGitHubAccountBackfillService } from '@main/core/github/services/folder-github-account-backfill-instance';
import { openFileSystem } from '@main/core/runtime/files-helpers';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import type { MachineRuntime } from '@main/core/runtime/types';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { gitRepoUpdateChannel } from '@shared/core/git/events';
import { PROJECT_CONFIG_FILE } from '@shared/core/project-settings/project-settings';
import { folderSettingsChangedChannel } from '@shared/core/folders/folder-events';
import type { Folder } from '@main/core/folders/folders';
import { ensureEmdashGitExcludedSafe } from './ensure-emdash-excluded';
import { FolderRuntime, type FolderRuntimeTransport } from './folder-runtime';
import { resolveFolderGitless } from './folder-gitless';
import type { FolderSettingsProvider } from './settings/provider';
import { LocalFolderSettingsProvider } from './settings/providers/local-folder-settings-provider';

export type CreateFolderRuntimeError = { message: string };

export async function createFolderRuntime(
  folder: Folder
): Promise<Result<FolderRuntime, CreateFolderRuntimeError>> {
  const ctx = new LocalExecutionContext({ root: folder.path });
  const runtimeLease = await runtimeManager.acquire();

  try {
    const folderFileSystem = openFileSystem(runtimeLease.value.files);
    if (!folderFileSystem.success) {
      await runtimeLease.release();
      return err({ message: folderFileSystem.error.message });
    }
    const gitless = await resolveFolderGitless(
      folder,
      folderFileSystem.data,
      runtimeLease.value.files.path
    );
    const settings = new LocalFolderSettingsProvider(
      folder.id,
      folder.path,
      // gugu #2358: a gitless folder has no default-branch fallback.
      gitless ? undefined : (folder.baseRef ?? undefined),
      folderFileSystem.data
    );
    await runLegacyFolderSettingsMigration(
      settings,
      runtimeLease.value.git,
      folder.path,
      gitless
    );
    // Both explicitly gitless projects and repositories whose metadata was
    // removed mount the ordinary directory without acquiring a Git lease.
    const repoLease = gitless ? undefined : await runtimeLease.value.git.openRepository(folder.path);
    try {
      const provider = buildProvider(
        folder.id,
        folder.path,
        {
          kind: 'local',
          ctx,
        },
        runtimeLease.value.files,
        folderFileSystem.data,
        settings,
        () => {},
        runtimeLease,
        repoLease
      );
      await backfillGitHubAccount(provider);
      return ok(provider);
    } catch (error) {
      await repoLease?.release();
      throw error;
    }
  } catch (error) {
    await runtimeLease.release();
    return err(toCreateFolderRuntimeError(error));
  }
}

function toCreateFolderRuntimeError(error: unknown): CreateFolderRuntimeError {
  return { message: error instanceof Error ? error.message : String(error) };
}

async function runLegacyFolderSettingsMigration(
  settings: LocalFolderSettingsProvider,
  git: IGitRuntime,
  repoPath: CanonicalPath,
  // gugu #2358: 非 git 项目(baseRef=null)必须走无 git 句柄的 ensure —— 见下。
  gitless: boolean
): Promise<void> {
  // gugu #2328: worktree lease 只为给迁移传 git 句柄;迁移已完成(本地 DB 标记)时不再
  // 为一个必然 no-op 的 ensure 开 worktree。
  // gugu #2358: 非 git 项目根本不是 git 仓,openWorktree 会抛 `fatal: not a git repository`。
  // 迁移唯一要 git 句柄的是 isFileCleanlyTracked(仅当存在共享配置文件时才查),非 git 项目无此文件 →
  // 无句柄直接 ensure 即可(仍会写迁移收敛标记,不会每次 mount 重试)。
  if (gitless || !(await settings.needsLegacyConfigMigration())) {
    await settings.ensure();
    return;
  }
  const lease = await git.openWorktree(repoPath);
  try {
    await settings.ensure({ git: lease.value });
  } finally {
    await lease.release();
  }
}

async function backfillGitHubAccount(provider: FolderRuntime): Promise<void> {
  try {
    const result = await folderGitHubAccountBackfillService.backfillFolder(provider);
    // gugu #2328(GAP #4): backfill 转后台后 mount 返回先于回填落库,renderer 可能已读走
    // 无 githubAccountId 的设置——落库成功即广播变更,让读方缓存失效。
    if (result.status === 'updated') {
      events.emit(folderSettingsChangedChannel, { folderId: provider.folderId });
    }
  } catch (error) {
    log.warn('createFolderRuntime: failed to backfill the folder GitHub account', {
      folderId: provider.folderId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildProvider(
  folderId: string,
  repoPath: CanonicalPath,
  transportMeta: Pick<FolderRuntimeTransport, 'kind' | 'ctx'>,
  files: MachineRuntime['files'],
  folderFileSystem: IFileSystem,
  settings: FolderSettingsProvider,
  dispose: () => void | Promise<void>,
  runtimeLease: Lease<MachineRuntime>,
  // gugu #2358: 非 git 项目没有 repo lease —— 三个 git 服务全部缺省。
  repoLease: Lease<IGitRepository> | undefined
): FolderRuntime {
  // Keep the folder's `.gugu/` runtime state (attachments, uploads) out of the
  // user's `git status`. Best effort and non-blocking.
  if (repoLease) ensureEmdashGitExcludedSafe(folderFileSystem, repoPath, folderId);

  const gitRepository = repoLease ? new GitRepositoryService(repoLease.value, settings) : undefined;
  const transport: FolderRuntimeTransport = {
    ...transportMeta,
    fileSystem: folderFileSystem,
    configPath: files.path.join(repoPath, PROJECT_CONFIG_FILE),
    resolvePath: (relativePath) => files.path.join(repoPath, relativePath),
    configPathForDirectory: (directoryPath) => files.path.join(directoryPath, PROJECT_CONFIG_FILE),
    settings,
  };
  // gugu #2358: 非 git 项目无 git 仓 → 不建 fetch 服务、不订阅 repo 更新(否则底层 openWorktree 抛错)。
  const gitRepositoryFetchService = gitRepository
    ? new GitRepositoryFetchService(gitRepository, () => gitRepository.getBaseRemote())
    : undefined;
  gitRepositoryFetchService?.start();
  const unsubscribeRepoUpdates = repoLease
    ? repoLease.value.subscribe((update) => {
        events.emit(gitRepoUpdateChannel, { folderId, update });
      })
    : undefined;

  const releaseLeases = async () => {
    unsubscribeRepoUpdates?.();
    await repoLease?.release();
    await runtimeLease.release();
  };

  const provider = new FolderRuntime(
    folderId,
    repoPath,
    transport,
    gitRepository,
    gitRepositoryFetchService,
    runtimeLease.value.git,
    async () => {
      await releaseLeases();
      await dispose();
    }
  );
  return provider;
}
