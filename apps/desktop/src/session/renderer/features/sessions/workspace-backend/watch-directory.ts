import { log } from '@renderer/utils/logger';
import { workspaceRpc } from './workspace-backend';

/**
 * Tells the machine a workspace lives on "someone is looking at this directory". Where a watch covers one directory
 * (Linux, `@@@tree-by-directories`), the workspace's change feed only carries directories leased like this, so a view
 * that re-reads on `fileChangesChannel` must hold one for the directory of what it shows. Returns the release.
 */
export function watchWorkspaceDirectory(projectId: string, workspaceId: string, directory: string): () => void {
  const files = workspaceRpc(projectId).files;
  // Started inside the promise: a bridge that refuses the call reports it like any failed call, not by throwing in an effect.
  const lease = Promise.resolve()
    .then(() => files.watchDirectory(projectId, workspaceId, directory))
    .then((result) => {
      if (result.success) return result.data.leaseId;
      log.warn('[watch-directory] not watched', { directory, error: result.error });
      return null;
    })
    .catch((error: unknown) => {
      log.warn('[watch-directory] not watched', { directory, error: String(error) });
      return null;
    });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    void lease.then((leaseId) => {
      if (leaseId) void files.releaseDirectoryWatch(projectId, workspaceId, leaseId).catch(() => {});
    });
  };
}
