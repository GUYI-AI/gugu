import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { resolveSession } from './session-workspace-manager';

export async function dehydrateSession(
  sessionId: string
): Promise<void> {
  const [row] = await db
    .select({ type: sessions.runtime })
    .from(sessions)
    .where(
      eq(sessions.id, sessionId)
    )
    .limit(1);

  if (row?.type === 'acp') {
    return;
  }

  const session = resolveSession(sessionId);
  await session?.sessions.detachSession(sessionId);
}
