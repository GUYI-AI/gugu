import { eq } from 'drizzle-orm';
import type { CanonicalPath } from '@gugu/session-core/files';
import { db } from '@main/db/client';
import { workspaces } from '@main/db/schema';
import { isRetiredRemoteWorkspace } from '@main/core/workspaces/resolve-workspace-kind';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';

/** The mounted runtime of a workspace (a folder or a directory inside one), mounting it on first use. */
export async function resolveWorkspace(workspaceId: string) {
  const cached = workspaceRegistry.get(workspaceId);
  if (cached) return cached;
  const { workspaceBootstrapService } = await import('@main/core/workspaces/workspace-bootstrap-service');
  return workspaceBootstrapService.ensureWorkspaceSetupForWorkspace(workspaceId);
}

/**
 * A workspace's local path from its persisted record: the path mounting it uses, known before (or without) mounting
 * it. Null when there is none: the row is missing, has no path, or is a retired remote row (its stored path is not a
 * folder on this computer). How to fail on null is the caller's.
 */
export function persistedWorkspacePath(workspaceId: string): CanonicalPath | null {
  const row = db
    .select({ path: workspaces.path, kind: workspaces.kind, type: workspaces.type, location: workspaces.location })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get();
  return row?.path && !isRetiredRemoteWorkspace(row) ? row.path : null;
}
