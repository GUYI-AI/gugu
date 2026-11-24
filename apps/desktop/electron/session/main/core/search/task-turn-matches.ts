import type BetterSqlite3 from 'better-sqlite3';
import type { ActivityPreviewSource } from '@gugu/session-chat-ui/activity-preview';
import { excerpt, type TaskTurnHit } from '@shared/core/search';
import { textCondition } from './text-condition';

/** A hit before its task is named: a task's name is the main process's to give (task-name.ts). */
export type TaskTurnMatch = Omit<TaskTurnHit, 'title'> & { agentDisplayName: string | null; messageTime?: bigint };

/**
 * What was said in local tasks (turn_text, kept from each session's timeline by core/session-index), newest first:
 * by when the turn started. Only the index is read; the turns themselves stay in their records.
 *
 * Its cost follows what is indexed: a short piece scans the indexed text and a common word ranks every match. So it
 * takes the connection it is given and never runs on the main thread (task-turn-search-worker.ts).
 */
export function matchTaskTurns(connection: BetterSqlite3.Database, query: string, limit = 30, offset = 0, indexSchema: 'main' | 'history_search' = 'main'): TaskTurnMatch[] {
  const condition = textCondition(query, 'turn_text', ['r.text']);
  if (!condition) return [];
  const where = condition.sql.replace('turn_text MATCH ?', `r.id IN (SELECT rowid FROM ${indexSchema}.turn_text WHERE turn_text MATCH ?)`);
  const rows = connection.prepare(`SELECT r.session_id, r.item_id, r.role, r.text, r.started_at, r.activity, r.message_time,
      json_extract(s.config, '$.agentDisplayName') AS agent_display_name, s.project_id, s.archived_at
    FROM ${indexSchema}.turn_text_rows r JOIN sessions s ON s.id = r.session_id
    WHERE ${where} AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = s.project_id AND p.workspace_provider != 'local')
    ORDER BY r.started_at IS NULL, r.started_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...condition.params, Math.min(Math.max(limit, 1), 100), Math.max(0, offset)) as {
      session_id: string; item_id: string; role: string; text: string; started_at: number | null; activity: string | null; message_time: string | null;
      agent_display_name: string | null; project_id: string; archived_at: string | null;
    }[];
  return rows.map((row) => ({
    sessionId: row.session_id, projectId: row.project_id, agentDisplayName: row.agent_display_name, archived: row.archived_at !== null,
    itemId: row.item_id, role: row.role === 'user' ? 'user' as const : 'assistant' as const, excerpt: excerpt(row.text, query),
    activity: row.activity ? JSON.parse(row.activity) as ActivityPreviewSource | null : null,
    at: row.started_at === null ? '' : new Date(row.started_at).toISOString(),
    ...(row.message_time === null ? {} : { messageTime: BigInt(row.message_time) }),
  }));
}
