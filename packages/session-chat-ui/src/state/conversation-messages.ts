import { safeDeliveredBody } from './delivery-presentation';
import { readDeliveryEnvelope, type DeliveryReadFacts } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import { parseMessageQuoteLink, readMessageQuote } from '@gugu/core/shared/ui/messageQuote';
import { messageReferenceId } from '@gugu/session-core/acp/client';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { withSentReplies } from './sent-replies';
import { conversationQuoteText } from './conversation-quote-text';

/** Match identities only; identical words in another message are never an anchor. */
export function resolveConversationMessageReference(turns: readonly TranscriptTurn[], reference: string, sessionId?: string): string | null {
  const source = parseMessageQuoteLink(reference);
  if (source?.kind === 'session' && source.sessionId !== sessionId) return null;
  reference = source?.kind === 'session' ? source.itemId : source?.kind === 'chat' ? `msg:${source.messageId}` : reference;
  const id = reference.replace(/^msg:/, '');
  const nativeMatches: string[] = [];
  for (const turn of turns) for (const item of withSentReplies(turn, { allDestinations: true }).items) {
    if (item.kind !== 'message') continue;
    if (source?.kind === 'session') {
      if (messageReferenceId(turn, item.id) === reference) nativeMatches.push(item.id);
      continue;
    }
    if (item.id === reference) return item.id;
    if (/:sent:([^:]+)$/.exec(item.id)?.[1] === id) return item.id;
    if (readDeliveryEnvelope(item.text)?.segments.some(segment => segment.facts?.messageId?.replace(/^msg:/, '') === id)) return item.id;
  }
  return nativeMatches.length === 1 ? nativeMatches[0]! : null;
}

/** 被引用那条在群里说的 ⇒ 那个群的对话 id(人读群名用);私聊没有。 */
function groupOf(facts: DeliveryReadFacts | null | undefined): string | undefined {
  return facts?.chatKind === 'group' && facts.sourceLink ? parseConversationLink(facts.sourceLink)?.chatId : undefined;
}

export type Quoted = { item: ChatMessage; text: string; from?: string; fromId?: string; self?: boolean; chatId?: string };

/**
 * What a stretch of turns contributes to reply anchors: group number / chat id → chat id (only groups whose deliveries
 * appear here), and message id → the message it names. A pure function of the turns, so a run of turns that did not
 * change keeps its index (`committedBuild`).
 */
export type ConversationIndex = { groups: ReadonlyMap<string, string>; messages: ReadonlyMap<string, Quoted> };

/** Anchors named in earlier turns than the ones being read (the committed runs before this one); read-only. */
export type ConversationEarlier = { message(id: string): Quoted | undefined; group(chatId: string): string | undefined };

export function conversationIndex(turns: readonly TranscriptTurn[], earlier?: ConversationEarlier): ConversationIndex {
  // 群号 / 对话 id → 对话 id,只收这段记录里见过的群投递:agent 自己发出去的那条只知道它填的 chat_id,
  // 认得出是个群才写群名;❌ 认不出就按群猜(私聊的 chat_id 也长这样)。
  const groups = new Map<string, string>();
  for (const turn of turns) for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    for (const segment of readDeliveryEnvelope(item.text)?.segments ?? []) {
      const chatId = groupOf(segment.facts);
      if (!chatId) continue;
      groups.set(chatId, chatId);
      if (segment.facts?.chat) groups.set(segment.facts.chat, chatId);
    }
  }
  const messages = new Map<string, Quoted>();
  for (const turn of turns) for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    const data = item as ChatMessage;
    const envelope = readDeliveryEnvelope(item.text);
    const first = envelope?.segments[0]?.facts;
    messages.set(item.id, { item: data, text: envelope ? envelope.segments.map(segment => safeDeliveredBody(segment.body)).join('\n\n') : data.text, from: first?.from ?? undefined, fromId: first?.fromId ?? undefined, self: data.role === 'assistant' || undefined, chatId: groupOf(first) });
    for (const segment of envelope?.segments ?? []) {
      const canonical = segment.facts?.messageId?.replace(/^msg:/, '');
      if (canonical) messages.set(canonical, { item: data, text: safeDeliveredBody(segment.body), from: segment.facts?.from ?? undefined, fromId: segment.facts?.fromId ?? undefined, chatId: groupOf(segment.facts) });
    }
    const sentId = /:sent:([^:]+)$/.exec(item.id)?.[1];
    if (sentId) messages.set(sentId, { item: data, text: data.text, self: true, chatId: data.sentChat ? groups.get(data.sentChat) ?? earlier?.group(data.sentChat) : undefined });
  }
  return { groups, messages };
}

/**
 * The anchors these turns name that their own index does not hold: a run of committed turns reads exactly these from
 * the runs before it, so they are part of what its drawing depends on (`committedBuild`).
 */
export function earlierAnchors(turns: readonly TranscriptTurn[], index: ConversationIndex): { messages: string[]; groups: string[] } {
  const messages: string[] = [], groups: string[] = [];
  for (const turn of turns) for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    if (readMessageQuote(item.text)) continue;
    const quoted = readDeliveryEnvelope(item.text)?.segments[0]?.facts?.replyTo?.messageId.replace(/^msg:/, '') ?? (item as ChatMessage).sentReplyTo;
    if (quoted && !index.messages.has(quoted)) messages.push(quoted);
    const sentChat = (item as ChatMessage).sentChat;
    if (sentChat && /:sent:[^:]+$/.test(item.id) && !index.groups.has(sentChat)) groups.push(sentChat);
  }
  return { messages, groups };
}

/**
 * View-only reply anchors; persisted messages and delivery envelopes stay untouched.
 * Only explicit anchors are quoted: a native quote link, a delivery's `reply_to`, or the `reply_to_message_id` the agent passed
 * to message_send (`sentReplyTo`). ❌ Falling back to "the input before it" — a direct output has no
 * reply target, and a guessed one reads as a reply to someone else (owner 10-28 新管家截图).
 * `index` is these turns' own anchors (`conversationIndex`); `earlier` answers for the turns before them.
 */
export function conversationMessages(turns: readonly TranscriptTurn[], index = conversationIndex(turns), earlier?: ConversationEarlier): TranscriptTurn[] {
  const quote = (id: string) => index.messages.get(id) ?? earlier?.message(id);
  return turns.map(turn => ({ ...turn, items: turn.items.map(item => {
    if (item.kind !== 'message') return item;
    const data = { ...item, sourceItemId: messageReferenceId(turn, item.id) };
    const native = readMessageQuote(data.text);
    if (native) return { ...data, text: native.body, conversationReply: {
      itemId: native.link, text: conversationQuoteText(native.excerpt), ...(native.sender ? { from: native.sender } : {}), unloaded: true,
    } };
    const reply = readDeliveryEnvelope(item.text)?.segments[0]?.facts?.replyTo;
    const quoted = reply?.messageId.replace(/^msg:/, '') ?? (item as ChatMessage).sentReplyTo;
    const original = quoted ? quote(quoted) : undefined;
    if (!original) return quoted ? { ...data, conversationReply: { itemId: quoted, text: reply?.preview ?? '', unloaded: true,
      ...(reply?.from ? { from: reply.from } : {}), ...(reply?.fromId ? { fromId: reply.fromId } : {}) } } : data;
    const conversationReply = { itemId: original.item.id, messageId: quoted, text: conversationQuoteText(original.text), ...(original.from ? { from: original.from } : {}),
      ...(original.fromId ? { fromId: original.fromId } : {}), ...(original.self ? { self: true } : {}), ...(original.chatId ? { chatId: original.chatId } : {}) };
    return { ...data, conversationReply };
  }) }));
}
