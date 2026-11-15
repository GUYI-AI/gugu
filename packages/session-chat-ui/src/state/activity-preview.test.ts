import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '../model';
import { defaultChatTranslator as translate } from '../localization';
import { activityPreviewLabel, activityPreviewSource } from './activity-preview';

const agent = 'user:11111111-1111-4111-8111-111111111111';
const owner = 'user:22222222-2222-4222-8222-222222222222';
const ctx = { translate, chatName: () => 'Test group', actor: (id: string) =>
  id === agent ? { id, type: 'agent' as const, name: 'Worker' } : { id, type: 'human' as const, name: 'Owner' } };
const input = (type = 'agent', from = agent) => ({ kind: 'message' as const, id: 'turn:input', seq: 0, role: 'user' as const,
  text: `<gugu_delivery route="chat" from="Worker" from_id="${from}" from_type="${type}"><![CDATA[private incoming body]]></gugu_delivery>` });
const record = (items: TranscriptTurn['items']): TranscriptTurn => ({ id: 'turn', seq: 0, initiator: 'user', items });
const label = (turn: TranscriptTurn, id: string) => activityPreviewLabel(activityPreviewSource(turn, id), ctx);

describe('folded activity search previews', () => {
  it('uses the original source identity but carries no delivery body into preview metadata', () => {
    const turn = { ...record([input()]), referenceId: 'source' };
    const source = activityPreviewSource(turn, 'source:input');
    expect(source).not.toBeNull();
    expect(JSON.stringify(source)).not.toContain('private incoming body');
    expect(activityPreviewLabel(source, ctx)).toBe('Received 1 message from Worker');
  });
  it('keeps owner, mixed and unknown inputs outside the activity preview', () => {
    for (const message of [input('human', owner), input('', 'user:unknown'), { ...input(), text: input().text + input('human', owner).text }]) {
      expect(label(record([message]), message.id)).toBeNull();
    }
  });
  it('uses the same directory classification for a historical agent delivery', () => {
    expect(label(record([input('')]), 'turn:input')).toBe('Received 1 message from Worker');
  });
  it('hides narration owned by a confirmed A2G send and keeps a direct owner send unchanged', () => {
    const narration = { kind: 'message' as const, id: 'narration', seq: 1, role: 'assistant' as const, text: 'private narration body' };
    const send = { kind: 'mcp-tool-call' as const, id: 'send', toolCallId: 'send', seq: 2, title: 'Send', tool: 'message_send', server: 'gugu', status: 'done' as const,
      rawInput: JSON.stringify({ chat_id: 'group', text: 'private outgoing body' }), outputText: 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)' };
    const turn = record([input(), narration, send]);
    const group = { ...ctx, chatKind: () => 'group' as const };
    const source = activityPreviewSource(turn, 'narration');
    expect(activityPreviewLabel(source, group)).toBe('Sent 1 message in Test group');
    expect(JSON.stringify(source)).not.toContain('private outgoing body');
    expect(JSON.stringify(source)).not.toContain('private narration body');
    const direct = record([input('human', owner), narration, { ...send, rawInput: JSON.stringify({ chat_id: 'direct', to_user_ids: [owner], text: 'Owner answer' }) }]);
    expect(activityPreviewLabel(activityPreviewSource(direct, 'narration'), ctx)).toBeNull();
  });
});

it('hides a group-reply-to-owner preview while keeping a direct owner answer readable', () => {
  const addresses = { target: { kind: 'chat' as const, conversationId: 'group', whisper: false, threadRootId: null },
    recipients: [owner], confirmed: true, chatKind: 'group', replyTo: null };
  const viewer = { ...ctx, viewerId: owner.slice(5) };
  expect(activityPreviewLabel({ kind: 'sent', id: 'reply', addresses }, viewer)).toBe('Replied to you in Test group');
  expect(activityPreviewLabel({ kind: 'sent', id: 'direct', addresses: { ...addresses, chatKind: 'ai' } }, viewer)).toBeNull();
});
