import type { TranscriptTurn } from '../acp/models/turns/turn';
import type { SessionRecordLocator, SessionRecordSource } from './contract';
import { sameTurnKeys } from './runtime-turn';

/**
 * The journal's whole turns placed among the record's folded turns by when they started: each journal turn goes
 * before the first record turn that started after it (a record turn with no start stays where it is). Both lists
 * keep their own order, so this is a pure function of the two files, the same on every read.
 *
 * `recorded`: turns the record holds too, journaled for what only the runtime knew of them, how they ended (an
 * engine that died mid-turn: the runtime's verdict, its exit code and stderr tail). Each gives its outcome to the
 * record turn that is the same turn (`sameTurnAs`) and started nearest to it, the last of equals: a prompt sent again
 * after it failed opens two turns alike, and the retry must not take the failure. One the record does not have (yet)
 * is shown whole.
 */
export function withJournalTurns(turns: readonly TranscriptTurn[], journal: readonly TranscriptTurn[], recorded: readonly TranscriptTurn[] = []): TranscriptTurn[] {
  if (recorded.length > 0) {
    const nearest = nearestSameTurns(turns, recorded);
    const patched = [...turns];
    const unmatched: TranscriptTurn[] = [];
    recorded.forEach((turn, at) => {
      const index = nearest[at]!;
      if (index < 0) unmatched.push(turn);
      else patched[index] = endedAs(patched[index]!, turn);
    });
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

const ended = new WeakMap<TranscriptTurn, { by: TranscriptTurn; turn: TranscriptTurn }>();

/** `turn` with the end `by` journaled for it; the same object on every read, so the timeline sees it unchanged. */
function endedAs(turn: TranscriptTurn, by: TranscriptTurn): TranscriptTurn {
  const known = ended.get(turn);
  if (known?.by === by) return known.turn;
  const next = { ...turn, ...(by.outcome ? { outcome: by.outcome } : {}), ...(by.endedAt === undefined ? {} : { endedAt: by.endedAt }) };
  ended.set(turn, { by, turn: next });
  return next;
}

const NONE: readonly number[] = [];

/**
 * For each of `recorded`, the index of the turn in `turns` that is the same turn and started nearest to it, the last
 * of equals; -1 for none. One pass over `turns`, looking up only the keys `recorded` has.
 */
function nearestSameTurns(turns: readonly TranscriptTurn[], recorded: readonly TranscriptTurn[]): number[] {
  const wanted = new Map<string, number[]>();
  recorded.forEach((turn, at) => {
    for (const key of sameTurnKeys(turn)) {
      const list = wanted.get(key);
      if (list) list.push(at);
      else wanted.set(key, [at]);
    }
  });
  const distance = (a: TranscriptTurn, b: TranscriptTurn) =>
    a.startedAt === undefined || b.startedAt === undefined ? Infinity : Math.abs(a.startedAt - b.startedAt);
  const nearest = recorded.map(() => -1);
  turns.forEach((turn, index) => {
    for (const key of sameTurnKeys(turn)) {
      for (const at of wanted.get(key) ?? NONE) {
        const best = nearest[at]!;
        if (best < 0 || distance(turn, recorded[at]!) <= distance(turns[best]!, recorded[at]!)) nearest[at] = index;
      }
    }
  });
  return nearest;
}

/** The record of a session that has none of an agent's, only gugu's journal beside it. */
export function emptyRecordSource(locator: SessionRecordLocator): SessionRecordSource {
  return { locator, start: async () => {}, stop: () => {} };
}
