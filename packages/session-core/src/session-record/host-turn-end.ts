import type { TranscriptTurn } from '../acp/models/turns/turn';

/** A host-observed end of a PTY engine. cutoff is an observation, not an invented completion time. */
export type HostTurnEnd = { cutoff: number; endedAt?: number };
export type HostTurnEnds = {
  read(): readonly HostTurnEnd[];
  subscribe(changed: () => void): () => void;
};

/** Native outcomes win. Use the first confirmed engine end after this turn began, never a later engine's end. */
export function applyHostTurnEnd(turn: TranscriptTurn, ends: readonly HostTurnEnd[]): TranscriptTurn {
  if (turn.outcome || turn.startedAt === undefined) return turn;
  const end = ends.find(one => one.cutoff >= turn.startedAt!);
  if (!end) return turn;
  return { ...turn, outcome: { kind: 'cancelled', reason: 'cancelled' }, hostEnd: { at: end.cutoff },
    ...(end.endedAt === undefined ? {} : { endedAt: end.endedAt }) };
}
