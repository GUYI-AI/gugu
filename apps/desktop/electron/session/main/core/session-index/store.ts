import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { closeSync, openSync, statSync } from 'node:fs';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { messageReferenceId } from '@gugu/session-core/acp/client';
import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { nativeMessageTime } from '@gugu/session-core/session-record/conversation-history-clear';
import { activityPreviewSources } from '@gugu/session-chat-ui/activity-preview';

export const sessionIndexPath = (database: string) => `${database}.session-search.sqlite`;

function searchText(text: string): string | null {
  if (isGuguSilence(text)) return null;
  return readDeliveryEnvelope(text)?.body ?? text;
}

export type IndexState = { stamp: string | null; retry_at: number | null };
export type TurnRow = { turn_id: string; started_at: number | null; ended_at: number | null; initiator: string | null; outcome_kind: string | null; outcome_message: string | null };

export function readIndexState(sqlite: Database.Database, sessionId: string): IndexState | undefined {
  return sqlite.prepare('SELECT stamp, retry_at FROM session_index_state WHERE session_id = ?').get(sessionId) as IndexState | undefined;
}

/** Keep the old tables intact for downgrade and copy their already indexed rows once, off the main thread. */
export function openSessionIndex(database: string): Database.Database {
  const path = sessionIndexPath(database);
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const empty = statSync(path).size === 0;
  const index = new Database(path, { fileMustExist: true });
  try {
    if (empty) index.pragma('auto_vacuum = INCREMENTAL');
    index.pragma('journal_mode = WAL');
    if (index.pragma('user_version', { simple: true }) === 1) return index;
    const legacy = new Database(database, { readonly: true });
    try {
      legacy.transaction(() => index.transaction(() => {
        index.exec(`
          CREATE TABLE session_index_turns (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, started_at INTEGER,
          ended_at INTEGER, initiator TEXT, outcome_kind TEXT, outcome_message TEXT, PRIMARY KEY (session_id, turn_id)) WITHOUT ROWID;
          CREATE INDEX session_index_turns_order ON session_index_turns (session_id, started_at);
          CREATE TABLE turn_text_rows (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
          started_at INTEGER, item_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, activity TEXT, message_time TEXT);
          CREATE INDEX turn_text_rows_turn ON turn_text_rows (session_id, turn_id);
          CREATE VIRTUAL TABLE turn_text USING fts5(text, content = 'turn_text_rows', content_rowid = 'id', tokenize = 'trigram case_sensitive 0');
          CREATE TRIGGER turn_text_rows_insert AFTER INSERT ON turn_text_rows BEGIN
          INSERT INTO turn_text (rowid, text) VALUES (NEW.id, NEW.text);
          END;
          CREATE TRIGGER turn_text_rows_delete AFTER DELETE ON turn_text_rows BEGIN
          INSERT INTO turn_text (turn_text, rowid, text) VALUES ('delete', OLD.id, OLD.text);
          END;
          CREATE TABLE session_index_state (session_id TEXT PRIMARY KEY, stamp TEXT, retry_at INTEGER);
          CREATE TABLE session_index_hashes (session_id TEXT, turn_id TEXT, hash TEXT NOT NULL, PRIMARY KEY (session_id, turn_id)) WITHOUT ROWID;
        `);
        const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE name IN ('session_index_turns', 'turn_text_rows', 'kv')").all();
        if (tables.length === 3) {
          const turns = index.prepare('INSERT INTO session_index_turns VALUES (?, ?, ?, ?, ?, ?, ?)');
          const text = index.prepare('INSERT INTO turn_text_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
          const mark = index.prepare('INSERT INTO session_index_state (session_id) VALUES (?)');
          for (const row of legacy.prepare('SELECT * FROM session_index_turns').raw().iterate()) turns.run(...row as unknown[]);
          for (const row of legacy.prepare('SELECT * FROM turn_text_rows').raw().iterate()) text.run(...row as unknown[]);
          for (const row of legacy.prepare("SELECT substr(key, 15) FROM kv WHERE key LIKE 'session-index:%'").raw().iterate()) mark.run(...row as unknown[]);
        }
        index.pragma('user_version = 1');
      })())();
    } finally {
      legacy.close();
    }
    return index;
  } catch (error) {
    index.close();
    throw error;
  }
}

export function createSessionIndexStore(sqlite: Database.Database) {
  function outcomeMessage(turn: TranscriptTurn): string | null {
    const outcome = turn.outcome as { detail?: string; said?: string } | undefined;
    return outcome?.detail ?? outcome?.said ?? null;
  }

  const removeText = sqlite.prepare('DELETE FROM turn_text_rows WHERE session_id = ? AND turn_id = ?');
  const removeTurn = sqlite.prepare('DELETE FROM session_index_turns WHERE session_id = ? AND turn_id = ?');
  const removeHash = sqlite.prepare('DELETE FROM session_index_hashes WHERE session_id = ? AND turn_id = ?');
  const storedHash = sqlite.prepare('SELECT hash FROM session_index_hashes WHERE session_id = ? AND turn_id = ?').pluck();
  const setHash = sqlite.prepare('INSERT OR REPLACE INTO session_index_hashes VALUES (?, ?, ?)');
  const insertTurn = sqlite.prepare('INSERT OR REPLACE INTO session_index_turns VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertText = sqlite.prepare(`INSERT INTO turn_text_rows (session_id, turn_id, started_at, item_id, role, text, activity, message_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const storedIds = sqlite.prepare('SELECT turn_id FROM session_index_turns WHERE session_id = ?').pluck();
  const markIndexed = sqlite.prepare('INSERT OR REPLACE INTO session_index_state (session_id, stamp) VALUES (?, ?)');
  const clearStamp = sqlite.prepare('UPDATE session_index_state SET stamp = NULL WHERE session_id = ?');
  const deleteState = sqlite.prepare('DELETE FROM session_index_state WHERE session_id = ?');

  function dropTurn(sessionId: string, id: string): void {
    removeText.run(sessionId, id);
    removeTurn.run(sessionId, id);
    removeHash.run(sessionId, id);
  }

  function putTurn(sessionId: string, turn: TranscriptTurn): boolean {
    const facts = [turn.startedAt ?? null, turn.endedAt ?? null, turn.initiator ?? null, turn.outcome?.kind ?? null, outcomeMessage(turn)];
    const rows: (string | null)[][] = [];
    let activity: Map<string, unknown> | null = null;
    for (const item of turn.items) {
      if (item.kind !== 'message' || typeof item.text !== 'string') continue;
      const text = searchText(item.text);
      if (!text) continue;
      activity ??= activityPreviewSources(turn);
      const time = nativeMessageTime(turn, item);
      const id = messageReferenceId(turn, item.id) ?? item.id;
      rows.push([id, item.role, text, JSON.stringify(activity.get(id) ?? null), time === undefined ? null : String(time)]);
    }
    const hash = createHash('sha256').update(JSON.stringify([facts, rows])).digest('base64');
    if (storedHash.get(sessionId, turn.id) === hash) return false;
    removeText.run(sessionId, turn.id);
    insertTurn.run(sessionId, turn.id, ...facts);
    for (const row of rows) insertText.run(sessionId, turn.id, turn.startedAt ?? null, ...row);
    setHash.run(sessionId, turn.id, hash);
    return true;
  }

  const replace = sqlite.transaction((sessionId: string, turns: readonly TranscriptTurn[], stamp: string | null) => {
    const gone = new Set(storedIds.all(sessionId) as string[]);
    for (const turn of turns) {
      gone.delete(turn.id);
      putTurn(sessionId, turn);
    }
    for (const id of gone) dropTurn(sessionId, id);
    markIndexed.run(sessionId, stamp);
  });

  const update = sqlite.transaction((sessionId: string, turns: readonly TranscriptTurn[], removed: readonly string[]) => {
    let changed = removed.length > 0;
    for (const id of removed) dropTurn(sessionId, id);
    for (const turn of turns) changed = putTurn(sessionId, turn) || changed;
    if (changed) clearStamp.run(sessionId);
  });

  const drop = sqlite.transaction((sessionId: string) => {
    for (const id of storedIds.all(sessionId) as string[]) dropTurn(sessionId, id);
    deleteState.run(sessionId);
  });

  const missing = sqlite.prepare(`INSERT INTO session_index_state (session_id, retry_at) VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET retry_at = excluded.retry_at WHERE retry_at IS NOT NULL`);

  return { replace, update, drop,
    failed(sessionId: string, retryAt: number) { missing.run(sessionId, retryAt); },
  };
}
