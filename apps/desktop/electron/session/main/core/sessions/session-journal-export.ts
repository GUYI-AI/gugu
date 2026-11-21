import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { JournalLine } from '@gugu/session-core/session-record';
import { log } from '@main/lib/logger';
import { sessionRecordHarnessForProvider } from '../session-timeline/locate';
import { mergeIntoJournal } from './session-journal';

const DONE = 'session-journal-export.done';

/**
 * The history that only the old turn table (`session_turns`) holds goes into each session's journal: every turn of a
 * session whose agent keeps no record gugu reads, and every owner notification. Runs before the database migrates,
 * since a migration drops that table; once it is gone there is nothing to do. A crash halfway runs it again next
 * start, and a second run adds nothing (`mergeIntoJournal` keeps one line per id).
 */
export async function exportStoredTurnsToJournals(sqlite: Database.Database, userData: string): Promise<void> {
  const done = join(userData, DONE);
  if (existsSync(done)) return;
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_turns'").get();
  if (table) {
    const rows = sqlite.prepare(`SELECT t.session_id AS sessionId, t.turn_id AS turnId, t.data AS data, s.provider AS provider
      FROM session_turns t LEFT JOIN sessions s ON s.id = t.session_id ORDER BY t.session_id, t.seq`)
      .iterate() as IterableIterator<{ sessionId: string; turnId: string; data: string; provider: string | null }>;
    let session: string | null = null;
    let lines: JournalLine[] = [];
    let sessions = 0, written = 0;
    const flush = async () => {
      if (session && lines.length > 0) { written += await mergeIntoJournal(session, lines); sessions += 1; }
      lines = [];
    };
    for (const row of rows) {
      if (row.sessionId !== session) { await flush(); session = row.sessionId; }
      if (!row.turnId.startsWith('owner-notify:') && sessionRecordHarnessForProvider(row.provider) !== null) continue;
      const turn = JSON.parse(row.data) as TranscriptTurn;
      lines.push({ id: `${row.turnId}@${turn.startedAt ?? 0}`, at: turn.startedAt ?? 0, turn });
    }
    await flush();
    log.info('sessionJournal: stored turns exported', { sessions, written });
  }
  writeFileSync(done, new Date().toISOString());
}
