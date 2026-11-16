import type { TranscriptSessionNotice } from './session-notice';
import type { TranscriptTurn } from './turn';

/**
 * Where a conversation was stepped back (#7304): the last kept turn carries one boundary that says how many turns were
 * removed after it. The removed turns are gone — from the agent and from this view — so the line only counts them.
 * The runtime transcript and the stored history both write it through this one function, so they agree after a reload.
 */
export function markHistoryReverted(turn: TranscriptTurn, removed: number, at: number): TranscriptTurn {
  const id = `${turn.id}:history-reverted`;
  const previous = turn.items.find((item): item is TranscriptSessionNotice => item.kind === 'session-notice' && item.id === id);
  const count = removed + Number(previous?.effectiveValue ?? 0);
  const notice: TranscriptSessionNotice = {
    kind: 'session-notice', id, code: 'history-reverted', detail: '', effectiveValue: String(count), at,
    seq: previous?.seq ?? turn.items.reduce((max, item) => Math.max(max, item.seq), -1) + 1,
  };
  return { ...turn, items: previous ? turn.items.map(item => item === previous ? notice : item) : [...turn.items, notice] };
}
