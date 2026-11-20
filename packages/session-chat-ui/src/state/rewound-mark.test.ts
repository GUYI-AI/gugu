import { describe, expect, it } from 'vitest';
import { unit, type ItemSegmenter, type SegmentCtx } from '@session-chat/core/units';
import { defaultChatTranslator } from '@session-chat/localization';
import type { ChatItem, TranscriptTurn } from '@session-chat/model';
import { flattenTier } from './flatten';

const segmenters = Object.fromEntries(['day-separator', 'message', 'turn-process', 'turn-outcome', 'session-notice', 'execute-tool-call', 'patch-tool-call', 'file-change-summary', 'opened-output'].map(kind => [kind, {
  kind, segment: item => [unit(item.kind, item, item, { key: 'self' })],
} satisfies ItemSegmenter]));
const context = { caches: {}, expanded: () => false, active: false, foldTurnProcess: true, agentConversation: false,
  translate: defaultChatTranslator, plan: () => null, pendingToolCallIds: () => new Set(), terminalOutputText: () => null,
  terminalExitStatus: () => null } as unknown as SegmentCtx;
const mark = { kind: 'session-notice', id: 'kept:history-reverted', seq: 3, code: 'history-reverted', detail: '', effectiveValue: '2', at: 5000 } as ChatItem;
const kept: TranscriptTurn = {
  id: 'kept', seq: 0, initiator: 'user', startedAt: 1000, endedAt: 4000, outcome: { kind: 'done', reason: 'end_turn' },
  items: [
    { kind: 'message', id: 'u', seq: 0, role: 'user', text: 'write it' },
    { kind: 'execute-tool-call', id: 't', seq: 1, toolCallId: 't', tool: 'Bash', title: 'echo hi > probe', status: 'done' },
    { kind: 'message', id: 'a', seq: 2, role: 'assistant', text: 'done' },
    mark,
  ] as TranscriptTurn['items'],
};
const next: TranscriptTurn = { ...kept, id: 'next', seq: 1, startedAt: 6000, items: [{ kind: 'message', id: 'u2', seq: 0, role: 'user', text: 'again' }] as TranscriptTurn['items'] };

describe('the rewound mark', () => {
  it('is drawn once, as the last row of the kept turn, before the next turn', () => {
    const ids = flattenTier([kept, next], context, segmenters).map(row => row.itemId);
    expect(ids.filter(id => id === 'kept:history-reverted')).toHaveLength(1);
    const at = ids.indexOf('kept:history-reverted');
    expect(ids.indexOf('u2')).toBe(at + 1);
    expect(ids.slice(0, at).some(id => id === 'a' || id === 'kept:process')).toBe(true);
  });
});
