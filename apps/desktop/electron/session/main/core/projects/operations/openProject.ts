import { err, ok, type Result } from '@gugu/session-shared';
import { projectManager } from '@main/core/projects/project-manager';
import { log } from '@main/lib/logger';
import type { OpenProjectError, OpenProjectSuccess } from '@shared/projects';
import { sessionBootTasks } from '../../boot-tasks';
import { checkIsValidDirectory } from '../path-utils';
import { ensureRepositoryWorkspace } from './ensure-repository-workspace';
import { getProjectById } from './getProjects';
import { PATH_ACCESS_PROBE_TIMEOUT_MS, probePathAccess } from './probe-path-access';

export async function openProject(
  projectId: string
): Promise<Result<OpenProjectSuccess, OpenProjectError>> {
  const project = await getProjectById(projectId);
  if (!project) return err({ type: 'error', message: `Project not found: ${projectId}` });
  if (project.type === 'local' && !checkIsValidDirectory(project.path)) {
    return err({ type: 'path-not-found', path: project.path });
  }
  if (project.type === 'local') {
    // 目录在,但读得动吗?被权限挡住时访问会一直挂着,不做有界探测的话整个挂载会
    // 一路阻塞到 20s 预算耗尽,最后报一句与真实原因无关的 timeout(#3611)。
    const probe = await probePathAccess(project.path);
    // 「挂着等授权」只有 macOS 的 TCC 会这样;别处权限错误当场以 failed 返回。别处的超时只说明进程忙
    // (启动时线程池 / 事件循环拥塞),判成被挡住就是把可读目录误判死 —— 交给挂载自己的预算。
    if (probe.kind === 'blocked' && process.platform === 'darwin') {
      log.warn('openProject: project path unreadable within probe budget', {
        projectId,
        path: project.path,
        timeoutMs: PATH_ACCESS_PROBE_TIMEOUT_MS,
      });
      return err({ type: 'path-access-blocked', path: project.path });
    }
    if (probe.kind === 'failed') {
      return err({ type: 'error', message: probe.message });
    }
  }
  const result = await projectManager.openProject(project);
  if (!result.success) {
    return err({ type: 'error', message: result.error.message });
  }
  // 启动时打不开记下的失败,由之后任何一次打开成功(按需打开也算)清掉 —— 清除只在这一处。
  sessionBootTasks.clear('project-open', projectId);

  // Ensure the project has a shared repository-root workspace row.
  // This is idempotent and handles both new projects and pre-migration rows.
  let repositoryWorkspaceId: string | null = null;
  try {
    repositoryWorkspaceId = ensureRepositoryWorkspace(project);
  } catch (error) {
    log.warn('openProject: ensureRepositoryWorkspace failed (non-fatal)', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return ok({
    repositoryWorkspaceId,
    baseRef: (await result.data.git.open()) ? project.baseRef : null,
  });
}
