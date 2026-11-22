import type { TranscriptTurn } from '@gugu/session-core/acp';
import { messageReferenceId } from '@gugu/session-core/acp/client';
import type { RecordCursor, SessionTimeline } from '@gugu/session-core/session-record';
import { nativeMessageTime } from '@gugu/session-core/session-record/conversation-history-clear';
import { activityPreviewSources } from '@gugu/session-chat-ui/activity-preview';
import { sqlite } from '@main/db/client';
import { searchText } from '@main/db/initialize';
import { log } from '@main/lib/logger';

/**
 * The session index: what each session's timeline holds, for the readers that ask about sessions nobody has open —
 * search, whether a session ever ran, how its last turn ended (`db/initialize.ts` `ensureSessionIndex`). Derived from
 * the timeline and nothing else: an open timeline keeps its session's rows current (`followSessionIndex`); a session
 * never opened since the index was built is read once (`ensureSessionIndexed`, the background pass).
 */

const indexedKey = (sessionId: string) => `session-index:${sessionId}`;

type TurnRow = { turn_id: string; started_at: number | null; ended_at: number | null; initiator: string | null; outcome_kind: string | null; outcome_message: string | null };

function outcomeMessage(turn: TranscriptTurn): string | null {
  const outcome = turn.outcome as { detail?: string; said?: string } | undefined;
  return outcome?.detail ?? outcome?.said ?? null;
}

const statements = () => ({
  clearSession: sqlite.prepare('DELETE FROM session_index_turns WHERE session_id = ?'),
  clearSessionText: sqlite.prepare('DELETE FROM turn_text_rows WHERE session_id = ?'),
  deleteTurn: sqlite.prepare('DELETE FROM session_index_turns WHERE session_id = ? AND turn_id = ?'),
  deleteTurnText: sqlite.prepare('DELETE FROM turn_text_rows WHERE session_id = ? AND turn_id = ?'),
  insertTurn: sqlite.prepare(`INSERT OR REPLACE INTO session_index_turns (session_id, turn_id, started_at, ended_at, initiator, outcome_kind, outcome_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  insertText: sqlite.prepare(`INSERT INTO turn_text_rows (session_id, turn_id, started_at, item_id, role, text, activity, message_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  markIndexed: sqlite.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch())'),
});
// Prepared once per connection (tests open one per case).
const prepared = new WeakMap<object, ReturnType<typeof statements>>();
const sql = () => {
  let found = prepared.get(sqlite);
  if (!found) { found = statements(); prepared.set(sqlite, found); }
  return found;
};

function putTurn(sessionId: string, turn: TranscriptTurn): void {
  const q = sql();
  q.deleteTurnText.run(sessionId, turn.id);
  q.insertTurn.run(sessionId, turn.id, turn.startedAt ?? null, turn.endedAt ?? null, turn.initiator ?? null, turn.outcome?.kind ?? null, outcomeMessage(turn));
  let activity: Map<string, unknown> | null = null;
  for (const item of turn.items) {
    if (item.kind !== 'message' || typeof item.text !== 'string') continue;
    const text = searchText(item.text);
    if (!text) continue;
    activity ??= activityPreviewSources(turn);
    const time = nativeMessageTime(turn, item);
    // Found under its source (`messageReferenceId`): the one id every copy of the turn shares, and what a reveal compares.
    const id = messageReferenceId(turn, item.id) ?? item.id;
    q.insertText.run(sessionId, turn.id, turn.startedAt ?? null, id, item.role,
      text, JSON.stringify(activity.get(id) ?? null), time === undefined ? null : String(time));
  }
}

/** All of a session's turns, as its timeline holds them now; the session counts as indexed from here on. */
export function writeSessionIndex(sessionId: string, turns: readonly TranscriptTurn[]): void {
  sqlite.transaction(() => {
    const q = sql();
    q.clearSession.run(sessionId);
    q.clearSessionText.run(sessionId);
    for (const turn of turns) putTurn(sessionId, turn);
    q.markIndexed.run(indexedKey(sessionId), '1');
  })();
}

/** Turns that changed, and turns that left (a revert, a fork). */
export function updateSessionIndex(sessionId: string, turns: readonly TranscriptTurn[], removedTurnIds: readonly string[]): void {
  sqlite.transaction(() => {
    const q = sql();
    for (const id of removedTurnIds) { q.deleteTurn.run(sessionId, id); q.deleteTurnText.run(sessionId, id); }
    for (const turn of turns) putTurn(sessionId, turn);
  })();
}

export function sessionIndexed(sessionId: string): boolean {
  return sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(indexedKey(sessionId)) !== undefined;
}

/** How many turns the session's timeline holds (`ensureSessionIndexed` first, for a session that may not be indexed). */
export function indexedTurnCount(sessionId: string): number {
  return (sqlite.prepare('SELECT count(*) AS n FROM session_index_turns WHERE session_id = ?').get(sessionId) as { n: number }).n;
}

/** The session's last turn by when it started, or null. */
export function lastIndexedTurn(sessionId: string): TurnRow | null {
  return (sqlite.prepare(`SELECT turn_id, started_at, ended_at, initiator, outcome_kind, outcome_message FROM session_index_turns
    WHERE session_id = ? ORDER BY started_at IS NULL, started_at DESC LIMIT 1`).get(sessionId) as TurnRow | undefined) ?? null;
}

/** Batches inside this window land as one write: a running turn publishes every chunk. */
const FLUSH_MS = 500;

/**
 * Keeps a session's rows current while its timeline is open: all of it at once, then what each batch changed.
 * A reset (another epoch, a replaced record) writes all of it again.
 */
export function followSessionIndex(sessionId: string, timeline: SessionTimeline): () => void {
  let changed = new Map<string, TranscriptTurn>();
  let removed = new Set<string>();
  let whole = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    try {
      if (whole) writeSessionIndex(sessionId, timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns);
      else updateSessionIndex(sessionId, [...changed.values()], [...removed]);
    } catch (error) {
      log.error('sessionIndex: write failed', { sessionId, error: String(error) });
    }
    whole = false; changed = new Map(); removed = new Set();
  };
  const schedule = () => { timer ??= setTimeout(flush, FLUSH_MS); };
  const snapshot = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER });
  writeSessionIndex(sessionId, snapshot.turns);
  const stop = timeline.subscribe(snapshot.cursor as RecordCursor, (result) => {
    if (!result.ok) whole = true;
    else {
      for (const id of result.batch.removedTurnIds) { removed.add(id); changed.delete(id); }
      for (const turn of result.batch.turns) { changed.set(turn.id, turn); removed.delete(turn.id); }
    }
    schedule();
  });
  return () => {
    stop();
    if (timer) { clearTimeout(timer); flush(); }
  };
}
