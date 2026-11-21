import type { FolderRuntime } from '@main/core/workspaces/folder-runtime/folder-runtime';
import type { WorkspaceFactoryContext } from './workspace-factory';

export type WorkspaceGitContext = Pick<WorkspaceFactoryContext, 'git'>;

/**
 * Which git a workspace uses.
 *
 * - The folder itself, and worktree rows of earlier releases: the folder runtime's one Git (whether the folder is a
 *   repository is read from disk, @@@disk-decides-git).
 * - A directory inside a folder (`kind = 'path'`): it is its own repository or none at all. ❌ Borrow the folder's
 *   Git — that is another repository's branches and remotes; nothing is injected, and the workspace reads and opens its
 *   own directory's Git (workspace-factory).
 */
export function workspaceGitContext(
  folder: Pick<FolderRuntime, 'git'>,
  workspace: { kind?: string | null; path: string }
): WorkspaceGitContext {
  return { git: workspace.kind === 'path' ? undefined : folder.git };
}
