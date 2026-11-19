import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';

/** A late program callback cannot open a new resource for an already-ended task. */
export async function assertTaskLive(sessionId: string): Promise<void> {
  const [task] = await db.select({ archivedAt: sessions.archivedAt })
    .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!task || task.archivedAt !== null) throw new Error('Projection task has ended');
}
