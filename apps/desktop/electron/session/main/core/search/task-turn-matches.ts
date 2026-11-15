import type BetterSqlite3 from 'better-sqlite3';
import { activityPreviewSources, type ActivityPreviewSource } from '@gugu/session-chat-ui/activity-preview';
import { excerpt, type TaskTurnHit } from '@shared/core/search';
import { textCondition } from './text-condition';

/** A hit before its task is named: a task's name is the main process's to give (task-name.ts). */
export type TaskTurnMatch = Omit<TaskTurnHit, 'title'> & { agentDisplayName: string | null };

/**
 * What was said in local tasks (turn_text, kept by triggers on session_turns), newest first.
 *
 * Newest is the turn's row order: a turn's created_at is only ever the insert-time default, so the two orders are one.
 * Sorting by created_at would read every matching turn's whole record (the column sits after `data`), and carrying
 * `data` through the sort copies it for every match. So the ranking reads only the index, and only the turns of the
 * hits returned are read, once each.
 *
 * Both reads are one snapshot: a turn's row number only names it while no other thread's write lands in between.
 *
 * Its cost still follows what is stored: a short piece scans the indexed text, a common word ranks every match, and each
 * returned turn is read and parsed whole, however long it is. So it takes the connection it is given and never runs on
 * the main thread (task-turn-search-worker.ts).
 */
export function matchTaskTurns(connection: BetterSqlite3.Database, query: string, limit = 30): TaskTurnMatch[] {
  const condition = textCondition(query, 'turn_text', ['r.text']);
  if (!condition) return [];
  const where = condition.sql.replace('turn_text MATCH ?', 'r.id IN (SELECT rowid FROM turn_text WHERE turn_text MATCH ?)');
  return connection.transaction(() => {
    const rows = connection.prepare(`WITH hit AS MATERIALIZED (SELECT r.id, r.session_id, r.seq FROM turn_text_rows r WHERE ${where}),
      top AS (SELECT hit.id, t.rowid AS turn_row FROM hit JOIN sessions s ON s.id = hit.session_id
        JOIN session_turns t ON t.session_id = hit.session_id AND t.seq = hit.seq
        WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = s.project_id AND p.workspace_provider != 'local')
        ORDER BY t.rowid DESC, hit.id DESC LIMIT ?)
      SELECT r.session_id, r.item_id, r.role, r.text, top.turn_row, json_extract(s.config, '$.agentDisplayName') AS agent_display_name, s.project_id, s.archived_at
      FROM top JOIN turn_text_rows r ON r.id = top.id JOIN sessions s ON s.id = r.session_id
      ORDER BY top.turn_row DESC, top.id DESC`).all(...condition.params, Math.min(Math.max(limit, 1), 100)) as {
        session_id: string; item_id: string; role: string; text: string; turn_row: number; agent_display_name: string | null; project_id: string; archived_at: string | null;
      }[];
    if (!rows.length) return [];
    const turns = new Map<number, { at: string; activity: Map<string, ActivityPreviewSource | null> }>();
    for (const turn of connection.prepare('SELECT rowid AS turn_row, created_at, data FROM session_turns WHERE rowid IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...new Set(rows.map((row) => row.turn_row))])) as { turn_row: number; created_at: string; data: string }[]) {
      turns.set(turn.turn_row, { at: turn.created_at, activity: activityPreviewSources(JSON.parse(turn.data)) });
    }
    return rows.flatMap((row) => {
      const turn = turns.get(row.turn_row);
      return turn ? [{ sessionId: row.session_id, projectId: row.project_id, agentDisplayName: row.agent_display_name, archived: row.archived_at !== null,
        itemId: row.item_id, role: row.role === 'user' ? 'user' as const : 'assistant' as const, excerpt: excerpt(row.text, query), activity: turn.activity.get(row.item_id) ?? null, at: turn.at }] : [];
    });
  })();
}
