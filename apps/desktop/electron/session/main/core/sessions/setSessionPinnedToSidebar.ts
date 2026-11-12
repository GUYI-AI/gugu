import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { sessionParentId } from './utils';

/**
 * #2548 固定到左侧栏 — the one write path, same shape as setSessionPinned: the renderer moves the row on the change
 * event. Only a top-level session can be pinned (a child is never a row of the left list); unpinning always works.
 */
export async function setSessionPinnedToSidebar(sessionId: string, isPinnedToSidebar: boolean): Promise<void> {
  const [row] = await db
    .select({ projectId: sessions.projectId, parentSessionId: sessions.parentSessionId, config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  if (isPinnedToSidebar && sessionParentId(row) !== null) {
    throw new Error(`Session ${sessionId} has a parent session; only a top-level session can be pinned to the sidebar`);
  }

  await db
    .update(sessions)
    .set({
      isPinnedToSidebar: isPinnedToSidebar ? 1 : 0,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(sessions.id, sessionId));

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: row.projectId,
    changes: { isPinnedToSidebar },
  });
}
