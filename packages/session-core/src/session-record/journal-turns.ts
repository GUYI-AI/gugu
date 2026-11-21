import type { TranscriptTurn } from '../acp/models/turns/turn';
import type { SessionRecordLocator, SessionRecordSource } from './contract';

/**
 * The journal's whole turns placed among the record's folded turns by when they started: each journal turn goes
 * before the first record turn that started after it (a record turn with no start stays where it is). Both lists
 * keep their own order, so this is a pure function of the two files, the same on every read.
 */
export function withJournalTurns(turns: readonly TranscriptTurn[], journal: readonly TranscriptTurn[]): TranscriptTurn[] {
  if (journal.length === 0) return [...turns];
  const out: TranscriptTurn[] = [];
  let next = 0;
  for (const turn of turns) {
    if (turn.startedAt !== undefined) {
      while (next < journal.length && (journal[next]!.startedAt ?? -Infinity) < turn.startedAt) out.push(journal[next++]!);
    }
    out.push(turn);
  }
  while (next < journal.length) out.push(journal[next++]!);
  return out;
}

/** The record of a session that has none of an agent's, only gugu's journal beside it. */
export function emptyRecordSource(locator: SessionRecordLocator): SessionRecordSource {
  return { locator, start: async () => {}, stop: () => {} };
}
