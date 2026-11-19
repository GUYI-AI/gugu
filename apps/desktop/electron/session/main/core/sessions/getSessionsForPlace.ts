import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getFolder } from '@main/core/folders/folders';
import { db } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
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
 * The sessions working in one folder on this machine, whatever group they live in (the task home has none): the folder
 * itself and any workspace inside it (a worktree), except what belongs to a folder nested inside it — the same answer
 * `rootFolderOf` gives a workspace. Reads only that folder's workspaces and their sessions (indexed), not every session.
 */
export async function getSessionsForFolder(folderId: string) {
  const folder = getFolder(folderId);
  if (!folder) throw new Error(`folder ${folderId} not found`);
  const prefix = `${folder.path}/`;
  const inside = sql`substr(${workspaces.path}, 1, ${prefix.length}) = ${prefix}`;
  const candidates = db.select({ id: workspaces.id, path: workspaces.path, kind: workspaces.kind }).from(workspaces)
    .where(or(eq(workspaces.id, folderId), inside)).all();
  const nested = candidates.filter((ws) => ws.kind === 'project-root' && ws.id !== folderId).map((ws) => `${ws.path}/`);
  const ids = candidates
    .filter((ws) => ws.id === folderId || !nested.some((root) => ws.path === root.slice(0, -1) || ws.path?.startsWith(root)))
    .map((ws) => ws.id);
  const rows = await db
    .select()
    .from(sessions)
    .where(and(inArray(sessions.workspaceId, ids), isNull(sessions.archivedAt)));
  return rows.map((r) => mapSessionRowToSession(r, false));
}
