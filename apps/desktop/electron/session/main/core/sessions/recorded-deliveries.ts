import type { TranscriptTurn } from '@gugu/session-core/acp';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { nativePromptOriginal } from './native-prompt-receipts';

/**
 * #980 Which deliveries the session's record shows the agent received: the delivery ids in its user messages, read
 * from its timeline. A prompt the agent recorded differently from what the host sent (Hermes flattens it) is read as
 * the host's original, by its receipt. null = no record to read, or some prompt cannot be told.
 */
export async function recordedDeliveryIds(sessionId: string): Promise<string[] | null> {
  const { recordTurns } = await import('@main/core/session-timeline/service');
  const turns = await recordTurns(sessionId);
  if (turns === 'no-record') return null;
  const ids = new Set<string>();
  const original = (text: string) => nativePromptOriginal(sessionId, text);
  for (const turn of turns) if (!noteDeliveries(turn, ids, original)) return null;
  return [...ids];
}

/** Add a turn's delivery ids to `into`; false = some prompt of it cannot be told. */
function noteDeliveries(turn: TranscriptTurn, into: Set<string>, original: (text: string) => string | null | undefined): boolean {
  for (const item of turn.items) {
    if (item.kind !== 'message' || item.role !== 'user') continue;
    const found = turnDeliveryIds(item.text, original);
    if (found === null) return false;
    for (const id of found) into.add(id);
  }
  return true;
}

/** The delivery ids of one recorded user prompt; null = cannot be told. */
function turnDeliveryIds(text: string, original: (text: string) => string | null | undefined): string[] | null {
  const host = original(text);
  if (host === null) return null;
  const reading = readDeliveryEnvelope(host ?? text);
  // A delivery tag the envelope reader cannot place, with no host original, is unknown, never evidence of an empty inbox.
  if (!reading && host === undefined && /<gugu_deliver(?:y|ies)[\s>]/.test(text)) return null;
  return reading?.segments.flatMap(segment => segment.facts?.messageId ? [segment.facts.messageId] : []) ?? [];
}
