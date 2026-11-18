// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ChatMessage, TranscriptTurn } from '../model';
import type { RenderUnit } from '../core/units';
import { normalizeMessage } from '../components/rows/message/message.def';
import { collectUserTurnUnits, makeUnitsView } from './flatten';

const message = (id: string, text = 'Owner input', extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ kind: 'message', id, seq: 0, role: 'user', text, ...extra });
const answer = (id: string, state = 'answered') => message(id, '<gugu_question_answer>\n'
  + JSON.stringify({ question_id: id, state, answers: [{ selected: ['Keep it'] }] }) + '\n</gugu_question_answer>');
const turn = (id: string, items: ChatMessage[]): TranscriptTurn => ({ id, seq: 0, initiator: 'user', items }) as TranscriptTurn;
const units = (items: ChatMessage[]): RenderUnit[] => items.map(item => ({ kind: 'message', id: item.id, itemId: item.id,
  groupId: item.id, groupRole: 'solo', gapBefore: 0, data: normalizeMessage(item) }));
const anchors = (item: ChatMessage) => collectUserTurnUnits([turn('turn', [item])],
  makeUnitsView(units([item]), []), {});

describe('sticky anchors follow row presentation without changing bare summaries', () => {
  it('does not pin answered or withdrawn question rows in either transcript tier', () => {
    const committed = answer('answered'), active = answer('withdrawn', 'withdrawn');
    expect(normalizeMessage(committed).questionAnswer).toEqual({ answer: 'Keep it' });
    expect(normalizeMessage(active).questionAnswer).toEqual({ answer: null });
    expect(collectUserTurnUnits([turn('committed', [committed]), turn('active', [active])],
      makeUnitsView(units([committed]), units([active])), {})).toEqual([]);
  });

  it.each([
    ['hook status', message('hook', 'Hook supplied text', { hookNotice: { hookName: 'PreToolUse', level: 'notice', body: 'Hook supplied text' } })],
    ['only attachments', message('file', '', { attachments: [{ id: 'f', name: 'report.pdf', kind: 'file' }] })],
    ['empty input', message('empty', '   ')],
    ['narration', message('narration', 'Working on it', { conversationNarration: true })],
    ['owner notification', message('notice', 'notification transport text', { ownerNotification: { requestId: 'notice' } as ChatMessage['ownerNotification'] })],
  ] as const)('preserves the existing summary for %s', (_label, item) => {
    expect(anchors(item)).toEqual([0]);
  });

  it('preserves scheduled input boundaries without granting them viewer ownership', () => {
    const item = message('scheduled', 'Scheduled work', { guguDelivery: { body: 'Scheduled work', segments: [
      { body: 'Scheduled work', facts: { route: 'scheduled', fromType: 'human', fromId: 'user:owner', messageId: 'schedule' } },
    ] } as ChatMessage['guguDelivery'] });
    expect(collectUserTurnUnits([turn('scheduled', [item])], makeUnitsView(units([item]), []),
      { delivered: true })).toEqual([0]);
    expect(anchors(item)).toEqual([]);
  });

  it.each([
    message('normal'),
    message('caption', 'Read this report', { attachments: [{ id: 'f', name: 'report.pdf', kind: 'file' }] }),
    message('quoted', '<gugu_question_answer>\nnot a protocol record\n</gugu_question_answer>'),
  ])('keeps an ordinary user text bubble pinnable: $id', item => {
    expect(anchors(item)).toEqual([0]);
  });
});
