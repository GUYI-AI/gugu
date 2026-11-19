// @@@group-folders — the group a session lives in is one fact, its row's `chat_id`: the agent joins that group when its
// identity is first minted, the folders it may start in are that group's, and the session list groups by it. Not where
// its agent lives (that is `bornInChatId`, which can be a private chat holding the task card).
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import type { BirthGroup } from '@shared/core/sessions/create-session';
import { sessionSpawnerId } from './utils';

/**
 * The group this session lives in, and how its agent takes the seat there: a task agent (a task card's session, a
 * child another session spawned) joins without a join notice; one a person or an App pulled in on purpose joins with
 * it. Null = no group, or no such session.
 */
export function sessionGroupOf(sessionId: string): BirthGroup | null {
  const row = db.select({
    chatId: sessions.chatId, config: sessions.config, spawnedBySessionId: sessions.spawnedBySessionId,
  }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row?.chatId) return null;
  return { chatId: row.chatId, asTask: Boolean(row.config?.taskChatId) || sessionSpawnerId(row) !== null };
}
