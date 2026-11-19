import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { terminals } from '@main/db/schema';
import { sessionWorkspaceManager } from '../sessions/session-workspace-manager';

export async function deleteTerminal({
  sessionId,
  terminalId,
}: {
  sessionId: string;
  terminalId: string;
}) {
  await db
    .delete(terminals)
    .where(
      and(
        eq(terminals.id, terminalId),
        eq(terminals.sessionId, sessionId)
      )
    );

  const session = sessionWorkspaceManager.getSession(sessionId);
  await session?.terminals.killTerminal(terminalId);
}
