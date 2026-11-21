import { gitErrorMessage, type DiffTarget, type GitObjectRef } from '@gugu/session-core/git';
import { err, ok } from '@gugu/session-shared';
import { log } from '@main/lib/logger';
import type {
  GitWorktreeCommitResult,
  GitWorktreeMutationResult,
  GitWorktreeSnapshotResult,
} from '@shared/core/git/rpc';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { revertWorktreeFiles, stageWorktreeFiles, unstageWorktreeFiles, worktreeOf } from './mutations';

export const gitWorktreeController = createRPCController({
  getWorktreeSnapshot: async (
        workspaceId: string
  ): Promise<GitWorktreeSnapshotResult> => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' });
      return ok(await worktree.getSnapshot());
    } catch (error) {
      log.error('gitCtrl.getWorktreeSnapshot failed', { workspaceId, error });
      return err({ type: 'git_error', message: gitErrorMessage(error) });
    }
  },

  getChangedFiles: async (workspaceId: string, base: DiffTarget) => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      return ok({ changes: await worktree.getChangedFiles(base) });
    } catch (error) {
      log.error('gitCtrl.getChangedFiles failed', { workspaceId, base, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getFileAtRef: async (workspaceId: string, filePath: string, ref: string) => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      return ok({ content: await worktree.getFileAtRef(filePath, ref) });
    } catch (error) {
      log.error('gitCtrl.getFileAtRef failed', { workspaceId, filePath, ref, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getFileAtIndex: async (workspaceId: string, filePath: string) => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      return ok({ content: await worktree.getFileAtIndex(filePath) });
    } catch (error) {
      log.error('gitCtrl.getFileAtIndex failed', { workspaceId, filePath, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getImageAtRef: async (workspaceId: string, filePath: string, ref: string) => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      return ok({ result: await worktree.getImageAtRef(filePath, ref) });
    } catch (error) {
      log.error('gitCtrl.getImageAtRef failed', { workspaceId, filePath, ref, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getImageAtIndex: async (workspaceId: string, filePath: string) => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      return ok({ result: await worktree.getImageAtIndex(filePath) });
    } catch (error) {
      log.error('gitCtrl.getImageAtIndex failed', { workspaceId, filePath, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  stageFiles: (
        workspaceId: string,
    filePaths: string[]
  ): Promise<GitWorktreeMutationResult> => {
    return stageWorktreeFiles(workspaceId, filePaths);
  },

  stageAllFiles: async (
        workspaceId: string
  ): Promise<GitWorktreeMutationResult> => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      const result = await worktree.stageAll();
      if (!result.success) return err(result.error);
      return ok({ sequences: result.data });
    } catch (error) {
      log.error('gitCtrl.stageAllFiles failed', { workspaceId, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  unstageFiles: (
        workspaceId: string,
    filePaths: string[]
  ): Promise<GitWorktreeMutationResult> => {
    return unstageWorktreeFiles(workspaceId, filePaths);
  },

  unstageAllFiles: async (
        workspaceId: string
  ): Promise<GitWorktreeMutationResult> => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      const result = await worktree.unstageAll();
      if (!result.success) return err(result.error);
      return ok({ sequences: result.data });
    } catch (error) {
      log.error('gitCtrl.unstageAllFiles failed', { workspaceId, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  revertFiles: (
        workspaceId: string,
    filePaths: string[]
  ): Promise<GitWorktreeMutationResult> => {
    return revertWorktreeFiles(workspaceId, filePaths);
  },

  revertAllFiles: async (
        workspaceId: string
  ): Promise<GitWorktreeMutationResult> => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      const result = await worktree.revertAll();
      if (!result.success) return err(result.error);
      return ok({ sequences: result.data });
    } catch (error) {
      log.error('gitCtrl.revertAllFiles failed', { workspaceId, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  commit: async (
        workspaceId: string,
    message: string
  ): Promise<GitWorktreeCommitResult> => {
    const worktree = await worktreeOf(workspaceId);
    if (!worktree) return err({ type: 'not_found' });
    return worktree.commit(message);
  },

  push: async (workspaceId: string, remote: string) => {
    const worktree = await worktreeOf(workspaceId);
    if (!worktree) return err({ type: 'not_found' });
    const result = await worktree.push(remote);
    return result;
  },

  pull: async (workspaceId: string) => {
    const worktree = await worktreeOf(workspaceId);
    if (!worktree) return err({ type: 'not_found' as const });
    const result = await worktree.pull();
    return result;
  },

  getLog: async (
        workspaceId: string,
    maxCount?: number,
    skip?: number,
    knownAheadCount?: number,
    remote?: string,
    base?: GitObjectRef,
    head?: GitObjectRef
  ) => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      const result = await worktree.getLog({
        maxCount,
        skip,
        knownAheadCount,
        preferredRemote: remote,
        base,
        head,
      });
      return ok({ commits: result.commits, aheadCount: result.aheadCount });
    } catch (error) {
      log.error('gitCtrl.getLog failed', { workspaceId, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },

  getCommitFiles: async (workspaceId: string, commitHash: string) => {
    try {
      const worktree = await worktreeOf(workspaceId);
      if (!worktree) return err({ type: 'not_found' as const });
      return ok({ files: await worktree.getCommitFiles(commitHash) });
    } catch (error) {
      log.error('gitCtrl.getCommitFiles failed', { workspaceId, commitHash, error });
      return err({ type: 'git_error' as const, message: gitErrorMessage(error) });
    }
  },
});
