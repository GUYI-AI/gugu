import type { ProjectProvider } from '@main/core/projects/project-provider';
import type { WorkspaceFactoryContext } from './workspace-factory';

export type WorkspaceGitContext = Pick<WorkspaceFactoryContext, 'git'>;

/**
 * 工作区的 git 跟着哪个文件夹走(#7341 项目挂的文件夹)。
 *
 * - 根目录,以及从前的 worktree 行:沿用项目的那一份 git(项目目录是不是仓库,由它照磁盘判)。
 * - 挂上来的文件夹(`kind = 'path'`):它是它自己的仓库,或者根本不是仓库。❌ 借根目录的 git —— 那是另一个
 *   仓库的分支与远端;不注入,工作区照它自己的目录判、自己开一份(workspace-factory)。
 */
export function workspaceGitContext(
  project: Pick<ProjectProvider, 'git'>,
  folder: { kind?: string | null; path: string }
): WorkspaceGitContext {
  return { git: folder.kind === 'path' ? undefined : project.git };
}
