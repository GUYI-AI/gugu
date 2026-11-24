import { describe, expect, it } from 'vitest';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { agentSendOf, messageSendTargetOf, turnPlaces } from '@gugu/session-core/session-record/reply-process';
import { sendAddressesOf } from '@gugu/session-core/session-record/send-addresses';
import { sentFileGroups } from '@gugu/session-core/session-record/sent-file-groups';
import type { TranscriptItem, TranscriptTurn } from '../model';
import { activityPreviewSources } from './activity-preview';
import { withSentReplies } from './sent-replies';

/**
 * @@@one-walk-turn — a send reads where it sits in its turn (the input before it, the top-level item holding it). These
 * readings are pinned on a turn with several inputs: whatever walks the turn to answer them must answer exactly this.
 */
const GROUP = '8c2a1660-abda-46f8-8c15-10f515955ffc', DM = '5e19d60e-d73f-4b24-8808-9e9768b77948';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = (id: string, n: number, chat: 'group' | 'dm', body: string, extra: { thread?: string } = {}): TranscriptItem => ({
  kind: 'message', id, seq: n, role: 'user', text: renderDeliveryEnvelope({
    route: 'chat', from: chat === 'dm' ? 'Wei (owner)' : 'd3', fromId: chat === 'dm' ? `user:${DM}` : 'user:peer', fromType: 'human',
    messageId: `msg:${uuid(n)}`, at: '2026-11-24 01:00 UTC+0', chat: chat === 'dm' ? DM : GROUP, chatKind: chat,
    sourceLink: `gugu-chat://${chat === 'dm' ? DM : GROUP}/${uuid(n)}`, content: body, ...extra,
  }),
} as TranscriptItem);
const said = (id: string, n: number, text: string): TranscriptItem => ({ kind: 'message', id, seq: n, role: 'assistant', text } as TranscriptItem);
const send = (id: string, n: number, args: Record<string, unknown>, fields: Record<string, unknown> = {}): TranscriptItem => ({
  kind: 'mcp-tool-call', id, seq: n, toolCallId: id, title: 'message_send', server: 'plugin_gugu-product_gugu', tool: 'message_send',
  status: 'done', rawInput: JSON.stringify(args), completedAt: 1_000 + n,
  outputText: JSON.stringify({ status: 'sent', message_id: uuid(500 + n), source_link: `gugu-chat://${String(args.chat_id)}/${uuid(500 + n)}` }),
  ...fields,
} as TranscriptItem);

const turn: TranscriptTurn = { id: 'turn-1', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
  input('in-1', 1, 'group', 'first question'),
  said('a-1', 2, 'looking'),
  send('s-1', 3, { chat_id: GROUP, text: 'answer one', reply_to_message_id: `msg:${uuid(1)}` }),
  input('in-2', 4, 'dm', 'a private ask'),
  { kind: 'tool-group', id: 'g-1', seq: 5, children: [
    send('s-2', 6, { chat_id: DM, text: 'private answer' }),
    { kind: 'execute-tool-call', id: 'x-1', seq: 7, toolCallId: 'x-1', title: 'ls', status: 'done' },
  ] },
  input('in-3', 8, 'group', 'in a thread', { thread: `msg:${uuid(1)}` }),
  send('f-1', 9, { chat_id: GROUP, file_path: '/tmp/a.txt', text: 'two files' }, { outputText: JSON.stringify({ status: 'sent', message_id: uuid(601), file_name: 'a.txt' }) }),
  send('f-2', 10, { chat_id: GROUP, file_path: '/tmp/b.txt' }, { outputText: JSON.stringify({ status: 'sent', message_id: uuid(602), file_name: 'b.txt' }) }),
  send('s-3', 11, { chat_id: GROUP, text: 'same words' }),
  said('a-2', 12, 'same words'),
  { kind: 'mcp-tool-call', id: 'r-1', seq: 13, toolCallId: 'r-1', title: 'session_message', server: 'plugin_gugu-product_gugu', tool: 'session_message',
    status: 'done', rawInput: JSON.stringify({ to: ['session:abc'], text: 'relayed' }), outputText: JSON.stringify({ recipients: [{ to: 'session:abc', message_id: uuid(700), status: 'queued' }] }) },
  input('in-4', 14, 'group', 'last one'),
  send('s-4', 15, { chat_id: DM, text: 'elsewhere' }),
  send('s-5', 16, { chat_id: GROUP, text: 'failed' }, { status: 'error' }),
  send('s-6', 17, { chat_id: GROUP, text: 'still going' }, { status: 'running', outputText: undefined }),
] as TranscriptTurn['items'] };

const leaves = (items: readonly TranscriptItem[]): TranscriptItem[] => items.flatMap(item => item.kind === 'tool-group' ? leaves(item.children as TranscriptItem[]) : [item]);

describe('a send reads where it sits in a turn with several inputs', () => {
  it('reads exactly as pinned', async () => {
    const places = turnPlaces(turn);
    const pinned = {
      replies: withSentReplies(turn),
      conversationReplies: withSentReplies(turn, { allDestinations: true }),
      previewSources: [...activityPreviewSources(turn)],
      fileGroups: sentFileGroups(places).map(group => ({ ...group, first: group.first.id, last: group.last.id })),
      perItem: leaves(turn.items).map(item => ({ id: item.id, send: agentSendOf(item, places), target: messageSendTargetOf(item, places), addresses: sendAddressesOf(item, places) })),
    };
    await expect(JSON.stringify(pinned, null, 1)).toMatchFileSnapshot('./__pinned__/sent-replies.multi-input.json');
  });
});
