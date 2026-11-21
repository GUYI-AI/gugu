import type { TranscriptTurn } from '../acp/models/turns/turn';
import type { SessionRecordLocator, SessionRecordSource } from './contract';
import { sameTurnAs } from './runtime-turn';

/**
 * The journal's whole turns placed among the record's folded turns by when they started: each journal turn goes
 * before the first record turn that started after it (a record turn with no start stays where it is). Both lists
 * keep their own order, so this is a pure function of the two files, the same on every read.
 *
 * `recorded`: turns the record holds too, journaled for what only the runtime knew of them, how they ended (an
 * engine that died mid-turn: the runtime's verdict, its exit code and stderr tail). Each gives its outcome to the
 * last record turn that is the same turn (`sameTurnAs`); one the record does not have (yet) is shown whole.
 */
export function withJournalTurns(turns: readonly TranscriptTurn[], journal: readonly TranscriptTurn[], recorded: readonly TranscriptTurn[] = []): TranscriptTurn[] {
  if (recorded.length > 0) {
    const patched = [...turns];
    const unmatched: TranscriptTurn[] = [];
    for (const turn of recorded) {
      const index = patched.findLastIndex(sameTurnAs(turn));
      if (index < 0) unmatched.push(turn);
      else patched[index] = { ...patched[index]!, ...(turn.outcome ? { outcome: turn.outcome } : {}), ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }) };
    }
    turns = patched;
    journal = unmatched.length === 0 ? journal : [...journal, ...unmatched].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }
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
