import type { GitRemote } from '@gugu/session-core/git';
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '@main/db/client';
import { workspaceRemotes } from '@main/db/schema';
import { parseRepositoryRef } from '@shared/repository-ref';

/**
 * Upsert all git remotes for a folder into the `workspace_remotes` table and
 * delete any rows that are no longer present in the live remote list.
 *
 * Called on every task provision and whenever the repository remotes model changes.
 */
export async function syncFolderRemotes(folderId: string, remotes: GitRemote[]): Promise<void> {
  for (const r of remotes) {
    const remoteUrl = parseRepositoryRef(r.url)?.repositoryUrl ?? r.url;
    await db
      .insert(workspaceRemotes)
      .values({ workspaceId: folderId, remoteName: r.name, remoteUrl })
      .onConflictDoUpdate({
        target: [workspaceRemotes.workspaceId, workspaceRemotes.remoteName],
        set: { remoteUrl },
      });
  }

  if (remotes.length > 0) {
    await db.delete(workspaceRemotes).where(
      and(
        eq(workspaceRemotes.workspaceId, folderId),
        notInArray(
          workspaceRemotes.remoteName,
          remotes.map((r) => r.name)
        )
      )
    );
  } else {
    // No remotes at all — clear all rows for this folder
    await db.delete(workspaceRemotes).where(eq(workspaceRemotes.workspaceId, folderId));
  }
}

