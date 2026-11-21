import { gitErrorMessage } from '@gugu/session-core/git';
import { err, ok } from '@gugu/session-shared';
import { resolveWorkspace } from '@main/core/workspaces/resolve-workspace';
import { log } from '@main/lib/logger';
import type { GitWorktreeMutationResult } from '@shared/core/git/rpc';

/** The workspace's worktree, read now (@@@disk-decides-git): undefined for an unknown workspace or a directory without Git. */
export async function worktreeOf(workspaceId: string) {
  return (await (await resolveWorkspace(workspaceId))?.git())?.worktree;
}

export async function stageWorktreeFiles(
    workspaceId: string,
  paths: string[]
): Promise<GitWorktreeMutationResult> {
  try {
    const worktree = await worktreeOf(workspaceId);
    if (!worktree) return err({ type: 'not_found' });
    const result = await worktree.stage(paths);
    if (!result.success) return err(result.error);
    return ok({ sequences: result.data });
  } catch (error) {
    log.error('gitCtrl.stage failed', { workspaceId, paths, error });
    return err({ type: 'git_error', message: gitErrorMessage(error) });
  }
}

export async function unstageWorktreeFiles(
    workspaceId: string,
  paths: string[]
): Promise<GitWorktreeMutationResult> {
  try {
    const worktree = await worktreeOf(workspaceId);
    if (!worktree) return err({ type: 'not_found' });
    const result = await worktree.unstage(paths);
    if (!result.success) return err(result.error);
    return ok({ sequences: result.data });
  } catch (error) {
    log.error('gitCtrl.unstage failed', { workspaceId, paths, error });
    return err({ type: 'git_error', message: gitErrorMessage(error) });
  }
}

export async function revertWorktreeFiles(
    workspaceId: string,
  paths: string[]
): Promise<GitWorktreeMutationResult> {
  try {
    const worktree = await worktreeOf(workspaceId);
    if (!worktree) return err({ type: 'not_found' });
    const result = await worktree.revert(paths);
    if (!result.success) return err(result.error);
    return ok({ sequences: result.data });
  } catch (error) {
    log.error('gitCtrl.revert failed', { workspaceId, paths, error });
    return err({ type: 'git_error', message: gitErrorMessage(error) });
  }
}
