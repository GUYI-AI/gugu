import { gitErrorMessage } from '@gugu/session-core/git';
import { err, ok } from '@gugu/session-shared';
import type { GitRepositorySnapshotResult } from '@shared/core/git/rpc';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { projectManager } from '../../projects/project-manager';
import { providerRepositoryService } from '../../repository/provider-repository-service';
import { resolveWorkspace } from '../../projects/utils';

export const gitRepositoryController = createRPCController({
  /**
   * #6264 这台电脑上 git 的署名(`git config --global user.name / user.email`)。别的机器上的 git 还没配署名时,
   * 审阅页就地问一句,输入框里默认填这一份(同一个人在自己电脑上用的名字)。取不到就是空串。
   */
  localIdentity: async (): Promise<{ name: string; email: string }> => {
    const [{ execFile }, { promisify }, os, { reviewGitEnv }, { getGitExecutable }, { loginShellEnv }] = await Promise.all([
      import('node:child_process'),
      import('node:util'),
      import('node:os'),
      import('../../runtime/review-git-env'),
      import('../../utils/exec'),
      import('@main/utils/userEnv'),
    ]);
    const run = promisify(execFile);
    const options = { cwd: os.homedir(), env: reviewGitEnv({ processEnv: process.env, loginShellEnv: loginShellEnv() }), timeout: 5_000 };
    const read = (key: string) =>
      run(getGitExecutable(), ['config', '--global', '--get', key], options).then(
        ({ stdout }) => stdout.trim(),
        () => ''
      );
    const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
    return { name, email };
  },

  getRepoSnapshot: async (projectId: string): Promise<GitRepositorySnapshotResult> => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    try {
      const repository = (await project.git.open())?.repository;
      if (!repository) return err({ type: 'not_found' as const });
      return ok(await repository.getSnapshot());
    } catch (e) {
      return err({ type: 'git_error' as const, message: gitErrorMessage(e) });
    }
  },

  getProjectRootHead: async (projectId: string) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    try {
      return ok({ head: await project.getProjectRootHead() });
    } catch (e) {
      return err({ type: 'git_error' as const, message: gitErrorMessage(e) });
    }
  },

  getDefaultBranch: async (projectId: string) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    try {
      const repository = (await project.git.open())?.repository;
      if (!repository) return err({ type: 'not_found' as const });
      return ok({ defaultBranch: await repository.getDefaultBranch() });
    } catch (e) {
      return err({ type: 'git_error' as const, message: gitErrorMessage(e) });
    }
  },

  resolveProviderRepository: async (projectId: string) => {
    return providerRepositoryService.resolveProject(projectId);
  },

  addRemote: async (projectId: string, name: string, url: string) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    const repository = (await project.git.open())?.repository;
    if (!repository) return err({ type: 'not_found' as const });
    const result = await repository.addRemote(name, url);
    if (!result.success) return err(result.error);
    return ok();
  },

  fetch: async (projectId: string, workspaceId?: string) => {
    const ws = workspaceId ? await resolveWorkspace(projectId, workspaceId) : undefined;
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });

    let result;
    if (workspaceId) {
      // A workspace without Git falls back to the project's fetch (an empty success when that has none either).
      const fetch = (await ws?.git())?.fetch;
      result = fetch ? await fetch.fetch() : await project.fetch();
    } else {
      result = await project.fetch();
    }

    if (!result.success) return err(result.error);
    return result;
  },

  publishBranch: async (
    projectId: string,
    branchName: string,
    remote: string,
    // 界面仍按原契约传它;从前只用来给遥测打标签,遥测拆了之后这里不再读。
    _workspaceId?: string
  ) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    const repository = (await project.git.open())?.repository;
    if (!repository) return err({ type: 'not_found' as const });
    const result = await repository.publishBranch(branchName, remote);
    return result;
  },

  fetchPrForReview: async (
    projectId: string,
    prNumber: number,
    headRefName: string,
    headRepositoryUrl: string,
    isFork: boolean
  ) => {
    const project = projectManager.getProject(projectId);
    if (!project) return err({ type: 'not_found' as const });
    const repository = (await project.git.open())?.repository;
    if (!repository) return err({ type: 'not_found' as const });
    const baseRemote = await repository.getBaseRemote();
    const result = await repository.fetchPrForReview(
      prNumber,
      headRefName,
      headRepositoryUrl,
      headRefName,
      isFork,
      baseRemote
    );
    if (!result.success) return err(result.error);
    return ok({ localBranch: headRefName });
  },
});
