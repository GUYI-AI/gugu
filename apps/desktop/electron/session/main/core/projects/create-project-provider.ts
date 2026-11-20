import type { IFileSystem } from '@gugu/session-core/files';
import type { CanonicalPath } from '@gugu/session-core/files';
import type { IGitRuntime } from '@gugu/session-core/git';
import { err, ok, type Lease, type Result } from '@gugu/session-shared';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { DirectoryGit } from '@main/core/git/repository/directory-git';
import { openFileSystem } from '@main/core/runtime/files-helpers';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import type { MachineRuntime } from '@main/core/runtime/types';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { gitRepoUpdateChannel } from '@shared/core/git/events';
import { PROJECT_CONFIG_FILE } from '@shared/core/project-settings/project-settings';
import { projectSettingsChangedChannel } from '@shared/core/projects/projectEvents';
import type { LocalProject } from '@shared/projects';
import { ensureEmdashGitExcludedSafe } from './ensure-emdash-excluded';
import { ProjectProvider, type ProjectProviderTransport } from './project-provider';
import type { ProjectSettingsProvider } from './settings/provider';
import { LocalProjectSettingsProvider } from './settings/providers/local-project-settings-provider';

export type CreateProviderError = { message: string };

export async function createProvider(
  project: LocalProject
): Promise<Result<ProjectProvider, CreateProviderError>> {
  const ctx = new LocalExecutionContext({ root: project.path });
  const runtimeLease = await runtimeManager.acquire();

  try {
    const projectFileSystem = openFileSystem(runtimeLease.value.files);
    if (!projectFileSystem.success) {
      await runtimeLease.release();
      return err({ message: projectFileSystem.error.message });
    }
    const settings = new LocalProjectSettingsProvider(
      project.id,
      project.path,
      // gugu #2358: 非 git 项目 baseRef=null → 无默认分支回退(undefined)。
      project.baseRef ?? undefined,
      projectFileSystem.data
    );
    const git = new DirectoryGit(
      project.path,
      runtimeLease.value.files.path.join(project.path, '.git'),
      runtimeLease.value.git,
      projectFileSystem.data,
      settings,
      (repository) => {
        // Keep the project's `.gugu/` runtime state (attachments, uploads) out of the user's `git status`.
        ensureEmdashGitExcludedSafe(projectFileSystem.data, project.path, project.id);
        return repository.subscribe((update) => events.emit(gitRepoUpdateChannel, { projectId: project.id, update }));
      }
    );
    try {
      await runLegacyProjectSettingsMigration(settings, runtimeLease.value.git, project.path, !(await git.open()));
      const provider = buildProvider(
        project.id,
        project.path,
        {
          kind: 'local',
          ctx,
        },
        runtimeLease.value.files,
        projectFileSystem.data,
        settings,
        () => {},
        runtimeLease,
        git
      );
      await migrateGitHubAccount(provider);
      return ok(provider);
    } catch (error) {
      await git.close();
      throw error;
    }
  } catch (error) {
    await runtimeLease.release();
    return err(toCreateProviderError(error));
  }
}

function toCreateProviderError(error: unknown): CreateProviderError {
  return { message: error instanceof Error ? error.message : String(error) };
}

async function runLegacyProjectSettingsMigration(
  settings: LocalProjectSettingsProvider,
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

/**
 * A project that picked a GitHub account before the password vault kept them: that pick becomes the vault's grant to the
 * project, and the old field goes (`null`, 「不用 GitHub」, stays). Without a pick, the connector's current account applies.
 */
async function migrateGitHubAccount(provider: ProjectProvider): Promise<void> {
  try {
    const legacy = (await provider.settings.get()).githubAccountId;
    if (typeof legacy !== 'string') return;
    const { migrateProjectGitHubAccount } = await import('@main/core/github/github-migration');
    await migrateProjectGitHubAccount(provider.projectId, legacy);
    const result = await provider.settings.patch({ githubAccountId: undefined });
    if (result.success) events.emit(projectSettingsChangedChannel, { projectId: provider.projectId });
  } catch (error) {
    // Left in place on failure, to move on the next mount; the connector shows the vault's problem meanwhile.
    log.warn('createProvider: the project\'s GitHub account could not move into the password vault', {
      projectId: provider.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildProvider(
  projectId: string,
  repoPath: CanonicalPath,
  transportMeta: Pick<ProjectProviderTransport, 'kind' | 'ctx'>,
  files: MachineRuntime['files'],
  projectFileSystem: IFileSystem,
  settings: ProjectSettingsProvider,
  dispose: () => void | Promise<void>,
  runtimeLease: Lease<MachineRuntime>,
  git: DirectoryGit
): ProjectProvider {
  const transport: ProjectProviderTransport = {
    ...transportMeta,
    fileSystem: projectFileSystem,
    projectConfigPath: files.path.join(repoPath, PROJECT_CONFIG_FILE),
    resolveProjectPath: (relativePath) => files.path.join(repoPath, relativePath),
    configPathForDirectory: (directoryPath) => files.path.join(directoryPath, PROJECT_CONFIG_FILE),
    settings,
  };
  const releaseProjectLeases = async () => {
    await git.close();
    await runtimeLease.release();
  };

  const provider = new ProjectProvider(
    projectId,
    repoPath,
    transport,
    git,
    runtimeLease.value.git,
    async () => {
      await releaseProjectLeases();
      await dispose();
    }
  );
  return provider;
}
