import { z } from 'zod';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { identityKeys } from '@gugu/session-core/session-record';
import type { ActivityEvent, ActivityQuery } from '@shared/core/activity';
import { activityJournal } from './collector';

export type ActivityAction = ({ action: 'activity_list' } & ActivityQuery)
  | { action: 'activity_context'; event_id: string; before_seq?: number };
export function isActivityAction(action: { action: string }): action is ActivityAction {
  return action.action === 'activity_list' || action.action === 'activity_context';
}
export async function runActivityAction(action: ActivityAction) {
  const journal = activityJournal();
  if (action.action === 'activity_list') {
    const { action: _, ...query } = action;
    return journal.list(query);
  }
  const event = journal.get(z.string().min(1).max(512).parse(action.event_id));
  const sessionId = event.session_id;
  if (!sessionId) throw new Error('This activity has no session context; use its source object');
  // The only path that opens a transcript. Kept dynamically separate from metadata queries.
  const before = z.number().int().nonnegative().optional().parse(action.before_seq);
  if (before === undefined && event.kind === 'session.turn_recorded' && event.related_object_id) {
    const anchored = await eventTurnContext(event, sessionId, event.related_object_id);
    if (anchored) return anchored;
  }
  const { recordHistoryPage } = await import('@main/core/session-timeline/service');
  const context = await recordHistoryPage({ conversationId: sessionId, limit: 4,
    ...(before !== undefined ? { beforeSeq: before } : {}) });
  if (!context.ok) return { event, context_available: false, reason: context.error };
  if (typeof context.value === 'string') return { event, context_available: false, reason: context.value };
  return { event, context_available: true, source: 'provider_record', scope: before !== undefined ? 'older_turns' : 'latest_four_turns',
    event_anchored: false, note: UNANCHORED_NOTE, has_older: context.value.hasOlder,
    next_before_seq: context.value.hasOlder ? context.value.turns.at(0)?.seq ?? null : null,
    context: context.value.turns.map(contextTurn) };
}

const UNANCHORED_NOTE = 'Source records are read now and may have changed; a turn event whose turn is no longer found (a revert) reads this way too. Unanchored windows are not event-time reconstructions. Claims of completion require verification.';

/**
 * A turn event names its turn by what the agent numbered in it (`identityKeys`: a tool call, a message id): the turn
 * is the one of the record now that has it. None has it (a revert or a rewrite took it out, or the record numbers
 * that differently) = undefined, and the latest turns are read unanchored instead.
 */
async function eventTurnContext(event: ActivityEvent, sessionId: string, key: string) {
  const { recordTurns } = await import('@main/core/session-timeline/service');
  // Unreadable is reported by the unanchored read that follows.
  const turns = await recordTurns(sessionId).catch(() => 'no-record' as const);
  if (turns === 'no-record') return undefined;
  const at = turns.findIndex(turn => identityKeys(turn).has(key));
  if (at < 0) return undefined;
  const turn = turns[at]!;
  return { event, context_available: true, source: 'provider_record', scope: 'event_turn', event_anchored: true,
    note: 'The turn this event recorded, as the record holds it now. Claims of completion require verification.',
    has_older: at > 0, next_before_seq: at > 0 ? turn.seq : null, context: [contextTurn(turn)] };
}

function contextTurn(turn: TranscriptTurn) {
  return { id: turn.id, sequence: turn.seq, started_at: turn.startedAt ?? null,
    ended_at: turn.endedAt ?? null, outcome: turn.outcome?.kind ?? null,
    inputs: turn.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? [{ id: item.id, text: item.text }] : []),
    latest_reply: [...turn.items].reverse().flatMap(item => item.kind === 'message' && item.role === 'assistant'
      ? [{ id: item.id, text: item.text, at: item.at ?? null }] : []).at(0) ?? null };
}
