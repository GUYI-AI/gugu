import { replica } from '@/lib/replica';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { workspaceEvents, workspaceRpc } from './workspace-backend';

export type WorkspaceImage = { dataUrl: string; mimeType: string; size: number };

/** Right after a write a file can briefly fail to read (mid-write): read again after these pauses before it is said. */
export const IMAGE_RETRY_DELAYS_MS = [120, 300, 600];

/**
 * An image file in a workspace as it is on disk (null: no such file), for every surface that shows one (a markdown
 * image, the diff's working-tree side); push-fed by the file feed.
 */
export const workspaceImage = replica({
  name: 'workspaceImage',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner, projectId: string, workspaceId: string, path: string): Promise<WorkspaceImage | null> => {
    const result = await workspaceRpc(projectId).files.readImage(projectId, workspaceId, path);
    if (!result.success) throw new Error(`reading the image ${path} failed`, { cause: result.error });
    const image = result.data;
    if (!image?.success) {
      if (/not found/i.test(image?.error ?? '')) return null;
      throw new Error(image?.error || `reading the image ${path} failed`);
    }
    if (!image.dataUrl) throw new Error(`the image ${path} was read without its data`);
    return { dataUrl: image.dataUrl, mimeType: image.mimeType ?? 'application/octet-stream', size: image.size ?? 0 };
  },
  fresh: Infinity,
  keep: 60_000,
  retry: IMAGE_RETRY_DELAYS_MS.length,
  retryDelay: (attempt) => IMAGE_RETRY_DELAYS_MS[Math.min(attempt, IMAGE_RETRY_DELAYS_MS.length - 1)]!,
  watch: {
    start: () => workspaceEvents.on(fileChangesChannel, ({ workspaceId, update }) => {
      if (update.kind === 'resync') { void workspaceImage.refresh(undefined, workspaceId); return; }
      for (const change of update.changes) void workspaceImage.refresh(undefined, workspaceId, change.path);
    }),
  },
});
