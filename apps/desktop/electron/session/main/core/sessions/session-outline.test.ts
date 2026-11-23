import { describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { OUTLINE_REPLY_CHARS } from '@shared/core/sessions/session-outline';

// The rail of a window that has loaded one page still shows the whole conversation: the machine that keeps it reads
// an outline off the session's timeline. What is pinned here is the reading of each turn, that it stops at the turn
// the window already has, and that a long conversation is read whole, in order.

const mocks = vi.hoisted(() => ({ turns: [] as TranscriptTurn[] }));
vi.mock('../session-timeline/service', () => ({ historyTurns: async () => mocks.turns }));
const { getOutline } = await import('./session-outline');

type Item = TranscriptTurn['items'][number];
const msg = (id: string, role: 'user' | 'assistant', text: string) => ({ kind: 'message', id, seq: 0, role, text }) as Item;
const tool = (id: string) => ({ kind: 'execute-tool-call', id, seq: 0, toolCallId: id, title: 'ls', command: 'ls', status: 'done', output: 'x'.repeat(4_000) }) as unknown as Item;
const turn = (id: string, initiator: 'user' | 'agent', items: Item[]): TranscriptTurn => ({ id, seq: 0, initiator, items }) as TranscriptTurn;
const delivery = (fromType: 'human' | 'agent', content: string) => renderDeliveryEnvelope({
  route: 'chat', from: fromType === 'human' ? 'Ada' : 'Worker', fromId: fromType === 'human' ? 'user:ada' : 'user:worker', fromType,
  messageId: `msg:${content}`, at: '2026-11-03', chat: '7', chatKind: 'group', content,
});

describe('the outline of a conversation', () => {
  it('reads what a rail would read off the same turns, up to the oldest one loaded', async () => {
    mocks.turns = [
      turn('r:0', 'user', [msg('r:0:u', 'user', 'typed ask'), tool('t'), msg('r:0:a', 'assistant', 'the reply'), msg('r:0:b', 'assistant', 'more')]),
      turn('r:1', 'agent', [msg('r:1:u', 'user', delivery('human', 'from a person')), msg('r:1:a', 'assistant', 'answer')]),
      turn('r:2', 'agent', [msg('r:2:u', 'user', delivery('agent', 'from an agent')), msg('r:2:a', 'assistant', 'answer')]),
      turn('r:3', 'user', [msg('r:3:u1', 'user', 'one'), msg('r:3:a1', 'assistant', 'first'), msg('r:3:u2', 'user', 'two'), msg('r:3:a2', 'assistant', 'second')]),
      turn('r:4', 'user', [msg('r:4:u', 'user', 'the newest, already loaded'), msg('r:4:a', 'assistant', 'ok')]),
    ];
    const { turns: outline } = await getOutline({ sessionId: 'c1', beforeTurnId: 'r:4' });
    // The agent's delivery is nobody's question; the turn the window has loaded is the window's own to draw.
    expect(outline.map(one => one.inputs.map(input => input.candidates.map(candidate => candidate.text))))
      .toEqual([[['typed ask']], [['from a person']], [['one'], ['two']]]);
    expect(outline.map(one => one.inputs.map(input => input.reply))).toEqual([['the reply'], ['answer'], ['first', 'second']]);
    expect(outline[0]).toMatchObject({ id: 'r:0', inputs: [{ itemId: 'r:0:u', first: true }] });
  });

  it('after a turn the reader already holds: only the stretch after it, marked; a turn it does not have: the whole outline', async () => {
    mocks.turns = ['r:0', 'r:1', 'r:2', 'r:3', 'r:4'].map((id) => turn(id, 'user', [msg(`${id}:u`, 'user', `ask ${id}`), msg(`${id}:a`, 'assistant', 'ok')]));
    const delta = await getOutline({ sessionId: 'c1', beforeTurnId: 'r:4', afterTurnId: 'r:1' });
    expect(delta).toMatchObject({ after: 'r:1' });
    expect(delta.turns.map((one) => one.id)).toEqual(['r:2', 'r:3']);
    const whole = await getOutline({ sessionId: 'c1', beforeTurnId: 'r:4', afterTurnId: 'gone' });
    expect(whole.after).toBeUndefined();
    expect(whole.turns.map((one) => one.id)).toEqual(['r:0', 'r:1', 'r:2', 'r:3']);
    expect(await getOutline({ sessionId: 'c1', beforeTurnId: 'r:0', afterTurnId: 'r:1' })).toEqual({ turns: [] });
  });

  it('sends the start of a long reply, not the reply', async () => {
    mocks.turns = [turn('r:0', 'user', [msg('u', 'user', 'ask'), msg('a', 'assistant', 'word '.repeat(40_000))]), turn('r:1', 'user', [])];
    const { turns: outline } = await getOutline({ sessionId: 'c1', beforeTurnId: 'r:1' });
    expect(outline[0]!.inputs[0]!.reply).toHaveLength(OUTLINE_REPLY_CHARS);
    expect(JSON.stringify(outline).length).toBeLessThan(1_000);
  });

  it('reads a long conversation whole and in order', async () => {
    mocks.turns = Array.from({ length: 180 }, (_unused, index) => turn(`r:${index}`, 'user', [msg(`r:${index}:u`, 'user', `ask ${index}`), msg(`r:${index}:a`, 'assistant', `reply ${index}`)]));
    const { turns: outline } = await getOutline({ sessionId: 'c1', beforeTurnId: 'r:170' });
    expect(outline.map(one => one.inputs[0]!.candidates[0]!.text)).toEqual(Array.from({ length: 170 }, (_unused, index) => `ask ${index}`));
  });

  it('has nothing to say when the window holds the first turn, or the turn is not in the history', async () => {
    mocks.turns = [turn('r:0', 'user', [msg('u', 'user', 'ask')])];
    expect(await getOutline({ sessionId: 'c1', beforeTurnId: 'r:0' })).toEqual({ turns: [] });
    expect(await getOutline({ sessionId: 'c1', beforeTurnId: 'gone' })).toEqual({ turns: [] });
  });
});
