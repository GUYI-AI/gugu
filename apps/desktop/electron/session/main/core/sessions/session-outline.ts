import { sqlite } from '@main/db/client';
import { OUTLINE_REPLY_CHARS, outlineOfMessages, type OutlineMessageRow, type StoredOutlineTurn } from '@shared/core/sessions/session-outline';

/** Rows are read a slice of turns at a time, yielding in between: the whole of a long conversation is a second of work. */
const OUTLINE_SLICE_TURNS = 50;

// Only message items leave the database, and of an agent's message only the start: the outline shows how a reply began.
const MESSAGES = `SELECT t.seq AS seq, json_extract(t.data, '$.id') AS turnId, json_extract(t.data, '$.referenceId') AS referenceId,
    json_extract(t.data, '$.initiator') AS initiator, json_extract(item.value, '$.id') AS itemId, json_extract(item.value, '$.role') AS role,
    CASE WHEN json_extract(item.value, '$.role') = 'user' THEN json_extract(item.value, '$.text')
      ELSE substr(json_extract(item.value, '$.text'), 1, ${4 * OUTLINE_REPLY_CHARS}) END AS text
  FROM session_turns t, json_each(t.data, '$.items') item
  WHERE t.session_id = ? AND t.seq >= ? AND t.seq < ? AND json_valid(t.data) AND json_extract(item.value, '$.kind') = 'message'
  ORDER BY t.seq, item.key`;

/**
 * The outline of the stored turns older than `before` (exclusive, like the history cursor), oldest first
 * (@@@outline-of-the-whole-conversation). `before` is the oldest turn the asking window has loaded: what it has loaded
 * it draws from the turns themselves.
 */
export async function getStoredOutline(params: { sessionId: string; before: number }): Promise<{ turns: StoredOutlineTurn[] }> {
  // The slices walk the turns that exist: `before` is the asker's number and may lie far above the newest of them.
  const stored = sqlite.prepare('SELECT min(seq) AS first, max(seq) AS last FROM session_turns WHERE session_id = ? AND seq < ?')
    .get(params.sessionId, params.before) as { first: number | null; last: number | null };
  if (stored.first === null || stored.last === null) return { turns: [] };
  const first = stored.first;
  const read = sqlite.prepare(MESSAGES);
  const slices: StoredOutlineTurn[][] = [];
  for (let end = stored.last + 1; end > first; end -= OUTLINE_SLICE_TURNS) {
    const start = Math.max(first, end - OUTLINE_SLICE_TURNS);
    slices.push(outlineOfMessages(read.all(params.sessionId, start, end) as OutlineMessageRow[]));
    // Other work of the main process runs between slices.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { turns: slices.reverse().flat() };
}
