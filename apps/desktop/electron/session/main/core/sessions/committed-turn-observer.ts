import { randomUUID } from 'node:crypto';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { identityKeys } from '@gugu/session-core/session-record/runtime-turn';
import { db } from '@main/db/client';
import { events } from '@main/lib/events';
import { sessionTurnSettledChannel } from '@shared/core/sessions/sessionEvents';
import { activitySignal } from '../activity/signals';
import { nativePublicationContext } from './native-publication-host';
import { prepareNativePublicationTurn } from './native-publication-turn';
import { noteNativeConversationHistory, noteNativeConversationReplies, truncateNativeConversationRead } from './session-conversation-read';
import { nativeConversationActivity } from './session-conversation-activity';
import { publishNativeConversationInbox, queueNativeConversationInbox } from './native-conversation-inbox';
import { keepNativePromptReceipts } from './native-prompt-receipts';
import { noteSwitchedModelReply } from './switched-model-memory';
import { persistWithTurnSettlement } from './turn-settlement';

export type CommittedTurnSource = 'live' | 'replay' | 'revision' | 'backfill';
type Committed = { sessionId: string; source: CommittedTurnSource; turn: TranscriptTurn };

/**
 * What a runtime's committed turn means beyond the history (the history is the provider record, or the Gugu journal
 * for a harness without one: `journalCommittedTurn`). Nothing here keeps the turn: a personal conversation's reply is
 * published and becomes unread, the receipts of the prompts it sent are kept (`native-prompt-receipts`), the conversation's preview moves, the first live reply opens its inbox chat, the
 * activity index hears of it. A turn arriving again (a later outcome, a late tail) is the same turn: publication
 * keeps its ids, unread keys are the same item ids. A replayed turn is history arriving late: it moves the preview
 * only. One session's turns are taken in order.
 */
export function observeCommittedTurn(input: Committed): Promise<void> {
  const previous = tails.get(input.sessionId) ?? Promise.resolve();
  const run = () => persistWithTurnSettlement(input, () => observe(input), receipt => events.emit(sessionTurnSettledChannel, receipt));
  const next = previous.then(run, run);
  const tail = next.then(() => undefined, () => undefined);
  tails.set(input.sessionId, tail);
  void tail.then(() => { if (tails.get(input.sessionId) === tail) tails.delete(input.sessionId); });
  return next;
}
const tails = new Map<string, Promise<void>>();

async function observe({ sessionId, source, turn }: Committed): Promise<void> {
  const context = source === 'live' ? await nativePublicationContext(sessionId) : null;
  // Publication is keyed by the turn's reference (or its id): a revision of the turn finds the ids it was given.
  const prepared = source === 'replay' ? null : prepareNativePublicationTurn({ sessionId, rowId: turn.id, source, turn, context }, db);
  const written = db.transaction(tx => {
    prepared?.commit(tx);
    if (source === 'live') keepNativePromptReceipts(sessionId, turn, tx);
    const publish = prepared ? noteNativeConversationReplies(sessionId, prepared.turn, turn, tx) : noteNativeConversationHistory(sessionId, turn, tx);
    const inbox = source === 'live' && nativeConversationActivity(sessionId, tx)?.turnId === turn.id && queueNativeConversationInbox(sessionId, tx);
    return { publish, inbox };
  });
  written.publish?.();
  if (written.inbox) publishNativeConversationInbox();
  if (source !== 'live') return;
  noteSwitchedModelReply(sessionId, turn.outcome);
  // The turn is found again by what the agent numbered in it (`identityKeys`): its id is the runtime's, not the record's.
  // A tool call id is the key records keep most alike across harnesses; else whatever the agent numbered first.
  const keys = [...identityKeys(turn)];
  const key = keys.find(one => one.startsWith('tool:')) ?? keys[0];
  activitySignal({ event_id: `session.turn_recorded:${randomUUID()}`, kind: 'session.turn_recorded', session_id: sessionId,
    object_id: turn.id, ...(key ? { related_object_id: key } : {}), occurred_at: turn.endedAt ?? null });
}

/**
 * A revert removed every turn from `from` (epoch ms) on, history included (the record, `revertJournal`): their
 * replies are no longer unread, the preview no longer shows one of them, and the activity index hears of it.
 */
export function forgetRevertedTurns(sessionId: string, from: number): void {
  truncateNativeConversationRead(sessionId, from)?.();
  activitySignal({ event_id: `session.history_reverted:${randomUUID()}`, kind: 'session.history_reverted',
    session_id: sessionId, occurred_at: Date.now() });
}
