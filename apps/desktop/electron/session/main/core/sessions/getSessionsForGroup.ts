import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { mapSessionRowToSession } from './utils';

/**
 * spec session-graph:会话的可见性只有一个过滤器 —— `sessions.archived_at`。群页与侧栏的会话列表都从这里读。
 * @@@group-folders — a group's sessions are the ones whose row names it (`sessions.chat_id`).
 */
export async function getSessionsForGroup(groupChatId: string) {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.chatId, groupChatId), isNull(sessions.archivedAt)));
  return rows.map((r) => mapSessionRowToSession(r, false));
}

/**
 * A folder's sessions: those that work in it (`sessions.workspace_id`, indexed), the same set its folder record counts
 * (`FolderRecord.sessionIds`). Covers folders bound to no group (the task home) too.
 */
export async function getSessionsForFolder(folderId: string) {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.workspaceId, folderId), isNull(sessions.archivedAt)));
  return rows.map((r) => mapSessionRowToSession(r, false));
}
