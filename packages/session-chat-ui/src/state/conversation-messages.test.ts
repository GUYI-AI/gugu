import { describe, expect, it } from 'vitest';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { ChatMessage, TranscriptTurn } from '../model';
import { conversationIndex, conversationMessages, earlierAnchors, type ConversationEarlier } from './conversation-messages';

/**
 * @@@committed-runs — the committed tier draws its turns run by run (ChatRoot). A run quotes from the runs before it
 * through `earlier`, and lists what it reads from them (`earlierAnchors`) so it is drawn again only when one of those
 * originals changes. A quote drawn this way must read exactly as it does when every turn is drawn in one pass.
 */
const delivered = (id: string, body: string, reply?: string): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'user', text:
  renderDeliveryEnvelope({ route: 'chat', from: 'd3', fromId: 'user:peer', fromType: 'human', messageId: `msg:${id}`, at: '2026-11-24 01:00 UTC+0',
    chat: 'group', chatKind: 'group', content: body,
    ...(reply ? { replyTo: { messageId: `msg:${reply}`, fromId: 'user:peer', from: 'd3', preview: reply } } : {}) }) });
const turn = (id: string, items: ChatMessage[]): TranscriptTurn => ({ id, seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: items as TranscriptTurn['items'] });
const replyOf = (turns: TranscriptTurn[], id: string) =>
  (turns.flatMap(t => t.items).find(item => item.id === id) as ChatMessage | undefined)?.conversationReply;

describe('reply anchors across committed runs', () => {
  const first = [turn('t1', [delivered('m1', 'The original line')])];
  const second = [turn('t2', [delivered('m2', 'Answering it', 'm1')])];

  it('resolves a quote of an earlier run exactly as one pass over all turns does', () => {
    const whole = conversationMessages([...first, ...second]);
    const index = conversationIndex(first);
    const earlier: ConversationEarlier = { message: id => index.messages.get(id), group: id => index.groups.get(id) };
    const byRun = conversationMessages(second, conversationIndex(second, earlier), earlier);
    expect(replyOf(byRun, 'm2')).toEqual(replyOf(whole, 'm2'));
    expect(replyOf(byRun, 'm2')).toMatchObject({ itemId: 'm1', text: 'The original line' });
  });

  it('names the anchors a run reads from the runs before it, and only those', () => {
    expect(earlierAnchors(second, conversationIndex(second))).toEqual({ messages: ['m1'], groups: [] });
    expect(earlierAnchors([...first, ...second], conversationIndex([...first, ...second]))).toEqual({ messages: [], groups: [] });
  });
});
