import { inArray } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type { SessionProjectLocation } from '@shared/core/projects/session-project-references';

/** Primary-key lookups only: restoring a few panes must not scan the account's session directory. */
export function sessionProjectLocations(sessionIds: string[]): SessionProjectLocation[] {
  const ids = [...new Set(sessionIds)];
  if (!ids.length) return [];
  // @@@group-folders — a saved layout keys a session by the same opaque key Session.projectId carries: its workspace.
  return db.select({ conversationId: sessions.id, workspaceId: sessions.workspaceId })
    .from(sessions).where(inArray(sessions.id, ids)).all()
    .flatMap((row) => row.workspaceId ? [{ conversationId: row.conversationId, projectId: row.workspaceId }] : []);
}
