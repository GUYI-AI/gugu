import { eq } from 'drizzle-orm'
import { db } from '@main/db/client'
import { sessions } from '@main/db/schema'
import { boundTaskName, knownTaskName } from './task-name'

const readable = (value: string | undefined, fallback: string) => {
  const name = value?.trim()
  return name && !/^(?:(?:user|agent|session):)?[0-9a-f-]{36}$/i.test(name) ? name : fallback
}

/** Presentation only, read from the same native session/roster as the transcript header. Never an approval. */
export function passwordRequestPresentation(ownerId: string, agentId: string, sessionId: string) {
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row || row.archivedAt || row.runtime !== 'acp') throw new Error('password_presentation_unavailable')
  const bound = boundTaskName(sessionId)
  if (bound && (bound.ownerUserId !== ownerId || bound.agentUserId !== agentId)) throw new Error('password_presentation_unavailable')
  return {
    agentName: readable(bound?.name, '此 Agent'),
    sessionTitle: readable(knownTaskName(row), '当前会话'),
  }
}
