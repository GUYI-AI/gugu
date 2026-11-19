import { gitErrorMessage } from '@gugu/session-core/git';
import { err, ok } from '@gugu/session-shared';
import { resolveWorkspace } from '@main/core/workspaces/resolve-workspace';
import { log } from '@main/lib/logger';
import type { GitWorktreeMutationResult } from '@shared/core/git/rpc';

export async function stageWorktreeFiles(
    workspaceId: string,
  paths: string[]
): Promise<GitWorktreeMutationResult> {
  try {
    const workspace = await resolveWorkspace(workspaceId);
    if (!workspace) return err({ type: 'not_found' });
    // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
    if (!workspace.gitWorktree) return err({ type: 'not_found' });
    const result = await workspace.gitWorktree.stage(paths);
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
    const workspace = await resolveWorkspace(workspaceId);
    if (!workspace) return err({ type: 'not_found' });
    // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
    if (!workspace.gitWorktree) return err({ type: 'not_found' });
    const result = await workspace.gitWorktree.unstage(paths);
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
    const workspace = await resolveWorkspace(workspaceId);
    if (!workspace) return err({ type: 'not_found' });
    // gugu #2358: 非 git 项目无 git worktree —— git 功能降级。
    if (!workspace.gitWorktree) return err({ type: 'not_found' });
    const result = await workspace.gitWorktree.revert(paths);
    if (!result.success) return err(result.error);
    return ok({ sequences: result.data });
  } catch (error) {
    log.error('gitCtrl.revert failed', { workspaceId, paths, error });
    return err({ type: 'git_error', message: gitErrorMessage(error) });
  }
}
