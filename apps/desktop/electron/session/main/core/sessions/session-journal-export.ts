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
 * session whose agent keeps no record gugu reads, every owner notification, and a recorded session's turns that ended
 * in an error only the runtime saw (kept as `recorded`, for their outcome, as `journalCommittedTurn` keeps them now).
 * Runs before the database migrates, since a migration drops that table; once it is gone there is nothing to do. A
 * crash halfway runs it again next start, and a second run adds nothing (`mergeIntoJournal` keeps one line per id).
 * It throws when it cannot finish: the start stops before the table is dropped.
 */
export async function exportStoredTurnsToJournals(sqlite: Database.Database, userData: string): Promise<void> {
  const done = join(userData, DONE);
  if (existsSync(done)) return;
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_turns'").get();
  if (table) {
    const ids = (sqlite.prepare('SELECT DISTINCT session_id AS id FROM session_turns').all() as { id: string }[]).map((row) => row.id);
    const rowsOf = sqlite.prepare(`SELECT t.turn_id AS turnId, t.data AS data, s.provider AS provider
      FROM session_turns t LEFT JOIN sessions s ON s.id = t.session_id WHERE t.session_id = ? ORDER BY t.seq`);
    let sessions = 0, written = 0;
    // One session's rows at a time, read whole: nothing holds a statement open across the journal writes.
    for (const sessionId of ids) {
      const lines: JournalLine[] = [];
      for (const row of rowsOf.all(sessionId) as { turnId: string; data: string; provider: string | null }[]) {
        const turn = JSON.parse(row.data) as TranscriptTurn;
        const recorded = !row.turnId.startsWith('owner-notify:') && sessionRecordHarnessForProvider(row.provider) !== null;
        if (recorded && turn.outcome?.kind !== 'error') continue;
        lines.push({ id: `${row.turnId}@${turn.startedAt ?? 0}`, at: turn.startedAt ?? 0, turn, ...(recorded ? { recorded: true as const } : {}) });
      }
      if (lines.length === 0) continue;
      written += await mergeIntoJournal(sessionId, lines);
      sessions += 1;
    }
    log.info('sessionJournal: stored turns exported', { sessions, written });
  }
  writeFileSync(done, new Date().toISOString());
}
