import type { FolderRuntime } from '@main/core/workspaces/folder-runtime/folder-runtime';
import type { WorkspaceFactoryContext } from './workspace-factory';

export type WorkspaceGitContext = Pick<
  WorkspaceFactoryContext,
  'gitless' | 'gitProbePath' | 'gitRepository' | 'gitRepositoryFetchService'
>;

/**
 * Which git a workspace uses.
 *
 * - The folder itself, and worktree rows of earlier releases: the git services the folder's runtime already has open.
 * - A directory inside a folder (`kind = 'path'`): it is its own repository or none at all. ❌ Borrow the folder's
 *   git services — those are another repository's branches and remotes; whether it is git is judged on its own
 *   directory, and if it is, the workspace opens its own (workspace-factory builds one when none is injected).
 */
export function workspaceGitContext(
  folder: Pick<FolderRuntime, 'isGitless' | 'gitRepository' | 'gitRepositoryFetchService'>,
  workspace: { kind?: string | null; path: string }
): WorkspaceGitContext {
  if (workspace.kind === 'path') {
    return {
      gitless: false,
      gitProbePath: workspace.path,
      gitRepository: undefined,
      gitRepositoryFetchService: undefined,
    };
  }
  return {
    gitless: folder.isGitless, // gugu #2358
    gitRepository: folder.gitRepository,
    gitRepositoryFetchService: folder.gitRepositoryFetchService,
  };
}
