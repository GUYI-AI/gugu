import type { TranscriptSessionNotice } from './session-notice';
import type { TranscriptTurn } from './turn';

/**
 * Where a conversation was stepped back: the last kept turn carries one notice that says how many turns were removed
 * after it. The removed turns are gone, from the agent and from this view, so the line only counts them. Only the
 * stored history writes it, in the same transaction that deletes those turns (`truncateStoredHistory`).
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

/**
 * A stored turn being replaced by a newer reading of it (a revision, a record backfill) keeps its rewound notice: the
 * notice exists only in the stored history, never in the harness's record or the runtime's replay of it.
 */
export function keepHistoryReverted(stored: TranscriptTurn, next: TranscriptTurn): TranscriptTurn {
  const notice = stored.items.find((item): item is TranscriptSessionNotice => item.kind === 'session-notice' && item.code === 'history-reverted');
  if (!notice || next.items.some((item) => item.kind === 'session-notice' && item.code === 'history-reverted')) return next;
  const seq = next.items.reduce((max, item) => Math.max(max, item.seq), -1) + 1;
  return { ...next, items: [...next.items, { ...notice, id: `${next.id}:history-reverted`, seq }] };
}
