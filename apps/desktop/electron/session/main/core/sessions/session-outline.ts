import type { TranscriptTurn } from '@gugu/session-core/acp';
import { OUTLINE_REPLY_CHARS, outlineOfMessages, type OutlineMessageRow, type SessionOutline } from '@shared/core/sessions/session-outline';

/**
 * The outline of the session's turns older than `beforeTurnId`, oldest first (@@@outline-of-the-whole-conversation),
 * read off its timeline. `beforeTurnId` is the oldest turn the asking window has loaded: what it has loaded it draws
 * from the turns themselves. A turn the timeline does not have (any more) has nothing older to outline.
 */
export async function getOutline(params: { sessionId: string; beforeTurnId: string; afterTurnId?: string }): Promise<SessionOutline> {
  const { historyTurns } = await import('../session-timeline/service');
  const turns = await historyTurns(params.sessionId);
  const at = turns.findIndex(turn => turn.id === params.beforeTurnId);
  if (at <= 0) return { turns: [] };
  // A reader that holds the outline up to `afterTurnId` asks only for what came after it (its loaded history moved on).
  // A turn this timeline does not have before `beforeTurnId` (rewound, another history): the whole outline, unmarked.
  const from = params.afterTurnId === undefined ? -1 : turns.findIndex(turn => turn.id === params.afterTurnId);
  if (from >= 0 && from < at) return { turns: outlineOfMessages(messageRows(turns.slice(from + 1, at))), after: params.afterTurnId };
  return { turns: outlineOfMessages(messageRows(turns.slice(0, at))) };
}

// Only message items are read, and of an agent's message only the start: the outline shows how a reply began.
function messageRows(turns: readonly TranscriptTurn[]): OutlineMessageRow[] {
  return turns.flatMap(turn => turn.items.flatMap(item => item.kind !== 'message' ? [] : [{
    turnId: turn.id, referenceId: turn.referenceId ?? null, initiator: turn.initiator ?? null, itemId: item.id, role: item.role,
    text: item.role === 'user' ? item.text : item.text.slice(0, 4 * OUTLINE_REPLY_CHARS),
  }]));
}
