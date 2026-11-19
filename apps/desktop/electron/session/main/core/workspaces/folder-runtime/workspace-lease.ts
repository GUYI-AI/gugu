import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { canonicalPath } from '@gugu/session-core/files';
import { err, ok } from '@gugu/session-shared';
import { eq } from 'drizzle-orm';
import { ensureFolder, isTaskHomeFolder, rootFolderOf } from '@main/core/folders/folders';
import { workspaceBootstrapService } from '@main/core/workspaces/workspace-bootstrap-service';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { db } from '@main/db/client';
import { workspaces } from '@main/db/schema';
import { openFolder } from './folder-runtimes';

/**
 * The draft workspace of the new-session page (the composer's file tools work here before a session exists): a folder
 * itself or a directory recorded inside it. Workspaces of another folder are refused.
 */
export async function acquireFolderWorkspace(folderId: string, workspaceId: string) {
  if (rootFolderOf(workspaceId)?.id !== folderId) {
    return err({ type: 'not-found' as const, message: 'Folder workspace not found' });
  }
  const opened = await openFolder(folderId);
  if (!opened.success) {
    return err({ type: 'folder-not-open' as const, message: 'Folder could not be opened' });
  }
  try {
    const workspace = await workspaceBootstrapService.ensureWorkspaceSetupForWorkspace(workspaceId);
    if (!workspace) return err({ type: 'not-found' as const, message: 'Folder workspace not found' });
    // A draft holds the mounted workspace like a session does (one more reference), released by releaseFolderWorkspace.
    const held = await workspaceRegistry.acquire(workspaceId, folderId, async () => {
      throw new Error(`Workspace ${workspaceId} was torn down while a draft was taking it`);
    });
    return ok({ workspaceId: held.workspace.id });
  } catch (error) {
    return err({
      type: 'acquire-failed' as const,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function releaseFolderWorkspace(folderId: string, workspaceId: string) {
  const belongsToFolder = workspaceRegistry
    .listForFolder(folderId)
    .some((workspace) => workspace.workspaceId === workspaceId);
  if (!belongsToFolder) return ok();

  try {
    await workspaceRegistry.teardown(workspaceId, 'detach');
    return ok();
  } catch (error) {
    return err({
      type: 'release-failed' as const,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The workspace of a directory: the folder recorded at it, a directory row inside a folder, or — outside every folder —
 * a new folder without a group (an App's own directory). Never binds anything to a group.
 */
export function workspaceAtDirectory(directory: string): string {
  const path = canonicalPath(directory);
  if (!statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
  const key = computeWorkspaceKey(path);
  const found = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.key, key)).get();
  if (found) return found.id;
  const id = randomUUID();
  db.insert(workspaces).values({ id, key, path, kind: 'path', type: 'local', location: 'local' }).run();
  if (rootFolderOf(id)) return id;
  db.delete(workspaces).where(eq(workspaces.id, id)).run();
  return ensureFolder(path).id;
}

/** Read/write an assistant's directory from the task home without binding it to a group. */
export async function acquireTaskDirectory(folderId: string, directory: string) {
  if (!isTaskHomeFolder(folderId)) throw new Error('A task workspace is required');
  const workspaceId = workspaceAtDirectory(directory);
  const root = rootFolderOf(workspaceId);
  if (!root) throw new Error(`Task directory ${directory} is in no folder`);
  return acquireFolderWorkspace(root.id, workspaceId);
}
