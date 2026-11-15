import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseMessageQuoteLink } from '@gugu/core/shared/ui/messageQuote';
import type { ChatMessage } from '@session-chat/model';
import type { RenderUnit } from '@session-chat/core/units';

/** Presentation follows visible messages, never process rows or completion notices. */
export function conversationSpeaker(item: ChatMessage): string | undefined {
  if (item.role === 'assistant') return '$agent';
  const delivery = item.guguDelivery ?? readDeliveryEnvelope(item.text);
  return delivery ? delivery.segments.at(-1)?.facts?.fromId ?? undefined : item.role === 'user' ? '$owner' : undefined;
}

/** The last message a reader would take as the previous speaker, among `units` before `end`. */
export function lastConversationMessage(units: readonly RenderUnit[], end = units.length): ChatMessage | undefined {
  for (let i = end - 1; i >= 0; i--) {
    const item = units[i]?.data as ChatMessage;
    if (units[i]?.kind === 'message' && item.conversationPart !== 'head' && !item.conversationNarration
      && !item.hookNotice && !item.questionAnswer && (item.role === 'user' || item.role === 'assistant')) return item;
  }
}

/** Direct model output has no reference chrome; message transport also requires an explicit anchor. */
export function messageReplyReference(item: ChatMessage): ChatMessage['conversationReply'] | null {
  if (item.conversationPart === 'body' || !item.conversationReply) return null;
  const delivered = item.guguDelivery ?? readDeliveryEnvelope(item.text);
  const quotedInput = item.role === 'user' && parseMessageQuoteLink(item.conversationReply.itemId);
  return item.sentReplyTo || item.sentTo || item.sentChat || delivered || quotedInput ? item.conversationReply : null;
}

const speaker = (key: string | undefined, selfUserId: string | undefined) => key === '$owner' && selfUserId ? `user:${selfUserId}` : key;
/** `previousSpeaker` is the one `decorateConversationDensity` stamps; flatten asks before that stamp, so it passes it in. */
export function conversationShowsName(item: ChatMessage, previousSpeaker: string | undefined, selfUserId: string | undefined): boolean {
  // What the reader typed here is theirs without saying so; a delivered message keeps its sender (owner 2026-11-07).
  if (conversationSpeaker(item) === '$owner') return false;
  const current = speaker(conversationSpeaker(item), selfUserId), previous = speaker(previousSpeaker, selfUserId);
  return !current || !previous || current !== previous;
}

/**
 * The quote moves to the footer when the header has neither a name nor a process row to sit beside. Measure and paint
 * (through `conversationHeaderLayout`) and flatten (the gap below this message) all ask here.
 */
export function conversationReferenceInFooter(item: ChatMessage, namePainted: boolean): boolean {
  return Boolean(messageReplyReference(item)) && !namePainted && !(item.role === 'assistant' && item.conversationProcess);
}

export function decorateConversationDensity(units: RenderUnit[], previous?: ChatMessage): RenderUnit[] {
  for (const unit of units) {
    if (unit.kind === 'turn-process') { unit.data = { ...(unit.data as object), conversationPreviousSpeaker: previous && conversationSpeaker(previous) }; continue; }
    if (unit.kind !== 'message') continue;
    const item = unit.data as ChatMessage;
    if (item.conversationNarration || item.hookNotice || item.questionAnswer || (item.role !== 'user' && item.role !== 'assistant')) continue;
    unit.data = { ...item, conversationPreviousSpeaker: previous && conversationSpeaker(previous) };
    if (item.conversationPart !== 'head') previous = item;
  }
  return units;
}
