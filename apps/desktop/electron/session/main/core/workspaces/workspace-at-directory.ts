import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { canonicalPath } from '@gugu/session-core/files';
import { eq } from 'drizzle-orm';
import { ensureFolder, rootFolderOf } from '@main/core/folders/folders';
import { db } from '@main/db/client';
import { workspaces } from '@main/db/schema';
import { computeWorkspaceKey } from './workspace-key';

/**
 * The workspace of a directory: the folder recorded at it, a directory row inside a folder, or — outside every folder —
 * a new folder without a group (an App's own directory). Never binds anything to a group.
 */
export function workspaceAtDirectory(directory: string): string {
  const path = canonicalPath(directory);
  if (!statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
  const key = computeWorkspaceKey(path);
  return db.transaction((tx) => {
    const found = tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.key, key)).get();
    if (found) return found.id;
    // A directory row first: rootFolderOf answers for recorded workspaces only. Outside every folder it gives way to
    // a folder of its own, in the same transaction.
    const id = randomUUID();
    tx.insert(workspaces).values({ id, key, path, kind: 'path', type: 'local', location: 'local' }).run();
    if (rootFolderOf(id, tx)) return id;
    tx.delete(workspaces).where(eq(workspaces.id, id)).run();
    return ensureFolder(path, {}, tx).id;
  });
}
