import { replica } from '@/lib/replica';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { workspaceEvents, workspaceRpc } from './workspace-backend';

/** An image a workspace file shows, as a `data:` URL (null: no such file); re-read by the file feed (`watchWorkspaceImages`). */
export const workspaceImage = replica({
  name: 'workspaceImage',
  scope: 'account',
  read: async (_owner, projectId: string, workspaceId: string, path: string): Promise<string | null> => {
    const result = await workspaceRpc(projectId).files.readImage(projectId, workspaceId, path);
    if (!result.success) throw new Error(`reading the image ${path} failed`, { cause: result.error });
    return result.data?.success ? result.data.dataUrl : null;
  },
  fresh: Infinity,
  keep: 60_000,
});

// One file-feed subscription however many images are shown; the bytes live in the replica.
let feed: { users: number; off: () => void } | null = null;

/** Follow workspace file changes while an image is shown; returns stop. */
export function watchWorkspaceImages(): () => void {
  if (!feed) {
    const off = workspaceEvents.on(fileChangesChannel, ({ workspaceId, update }) => {
      if (update.kind === 'resync') { void workspaceImage.refresh(undefined, workspaceId); return; }
      for (const change of update.changes) void workspaceImage.refresh(undefined, workspaceId, change.path);
    });
    feed = { users: 0, off };
  }
  const active = feed;
  active.users += 1;
  return () => {
    if (--active.users > 0) return;
    active.off();
    if (feed === active) feed = null;
  };
}
