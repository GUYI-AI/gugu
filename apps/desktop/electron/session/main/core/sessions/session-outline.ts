import { sqlite } from '@main/db/client';
import { nativeConversationHistoryFloor } from './native-publication-host';
import { historyTime } from '@gugu/core/shared/conversationHistoryTime';
import { OUTLINE_REPLY_CHARS, outlineOfMessages, type OutlineMessageRow, type StoredOutlineTurn } from '@shared/core/sessions/session-outline';
import { readSessionTurn } from './session-turn-storage';

/** Rows are read a slice of turns at a time, yielding in between: the whole of a long conversation is a second of work. */
const OUTLINE_SLICE_TURNS = 50;

const MESSAGES = `SELECT id,seq FROM session_turns WHERE session_id=? AND seq>=? AND seq<? ORDER BY seq`;

/**
 * The outline of the stored turns older than `before` (exclusive, like the history cursor), oldest first
 * (@@@outline-of-the-whole-conversation). `before` is the oldest turn the asking window has loaded: what it has loaded
 * it draws from the turns themselves.
 */
export async function getStoredOutline(params: { sessionId: string; before: number }): Promise<{ turns: StoredOutlineTurn[] }> {
  const floor = await nativeConversationHistoryFloor(params.sessionId);
  const boundary = floor ? Number((historyTime(floor) + 999_999n) / 1_000_000n) : null;
  // The slices walk the turns that exist: `before` is the asker's number and may lie far above the newest of them.
  const stored = sqlite.prepare('SELECT min(seq) AS first, max(seq) AS last FROM session_turns WHERE session_id = ? AND seq < ?')
    .get(params.sessionId, params.before) as { first: number | null; last: number | null };
  if (stored.first === null || stored.last === null) return { turns: [] };
  const first = stored.first;
  const read = sqlite.prepare(MESSAGES);
  const slices: StoredOutlineTurn[][] = [];
  for (let end = stored.last + 1; end > first; end -= OUTLINE_SLICE_TURNS) {
    const start = Math.max(first, end - OUTLINE_SLICE_TURNS);
    const messages: OutlineMessageRow[] = [];
    for (const row of read.all(params.sessionId, start, end) as { id: string; seq: number }[]) {
      const turn = readSessionTurn(sqlite, row, { messagesOnly: true });
      for (const item of turn.items) if (item.kind === 'message') {
        const at = item.at ?? (item.role === 'user' ? turn.startedAt : turn.endedAt);
        if (boundary !== null && (at === undefined || at < boundary)) continue;
        messages.push({ seq: row.seq, turnId: turn.id, referenceId: turn.referenceId ?? null, initiator: turn.initiator,
          itemId: item.id, role: item.role, text: item.role === 'user' ? item.text : Array.from(item.text).slice(0, 4 * OUTLINE_REPLY_CHARS).join('') });
      }
    }
    slices.push(outlineOfMessages(messages));
    // Other work of the main process runs between slices.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { turns: slices.reverse().flat() };
}
