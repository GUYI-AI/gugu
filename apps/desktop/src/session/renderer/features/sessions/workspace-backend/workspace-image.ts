import { replica } from '@/lib/replica';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { workspaceEvents, workspaceRpc } from './workspace-backend';

/**
 * An image a workspace file shows, as a `data:` URL (null: no such file). Push-fed: one file-feed subscription while any
 * image is shown reads a changed file again; an image shown again (kept for a minute) is read again then.
 */
export const workspaceImage = replica({
  name: 'workspaceImage',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner, projectId: string, workspaceId: string, path: string): Promise<string | null> => {
    const result = await workspaceRpc(projectId).files.readImage(projectId, workspaceId, path);
    if (!result.success) throw new Error(`reading the image ${path} failed`, { cause: result.error });
    return result.data?.success ? result.data.dataUrl : null;
  },
  fresh: Infinity,
  keep: 60_000,
  watch: {
    start: () => workspaceEvents.on(fileChangesChannel, ({ workspaceId, update }) => {
      if (update.kind === 'resync') { void workspaceImage.refresh(undefined, workspaceId); return; }
      for (const change of update.changes) void workspaceImage.refresh(undefined, workspaceId, change.path);
    }),
  },
});
