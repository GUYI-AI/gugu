import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-chat-ui';
import { mergeDeliveryEnvelopes, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TimelineRailOptions } from '@gugu/core/shared/timelineRail';
import { OUTLINE_PROMPT_CHARS, OUTLINE_REPLY_CHARS, outlineOfMessages, type OutlineMessageRow } from '../../../../apps/desktop/src/session/shared/core/sessions/session-outline';
import { timelineTurnsFromOutline, timelineTurnsFromTranscript } from '../../../../apps/desktop/src/session/renderer/features/sessions/view/session-timeline-turns';

/**
 * The rail draws loaded turns from the turns themselves and the turns older than them from an outline the machine
 * reads off its database. Both must say the same thing about the same turn: an entry keeps its id, its prompt and its
 * sender when its page loads, and the rail does not reshuffle under the pointer.
 */
const msg = (id: string, role: 'user' | 'assistant', text: string) =>
  ({ kind: 'message', id, seq: 0, role, text }) as TranscriptTurn['items'][number];
const tool = (id: string) => ({ kind: 'execute-tool-call', id, seq: 0, toolCallId: id, title: 'ls', command: 'ls', status: 'done' }) as TranscriptTurn['items'][number];
const turn = (seq: number, initiator: 'user' | 'agent', items: TranscriptTurn['items'], referenceId?: string): TranscriptTurn =>
  ({ id: `s:turn:s${seq}`, seq, initiator, items, ...(referenceId ? { referenceId } : {}) }) as TranscriptTurn;
const envelope = (overrides: Partial<Parameters<typeof renderDeliveryEnvelope>[0]> = {}) => renderDeliveryEnvelope({
  route: 'chat', from: 'Ada', fromId: 'user:ada', fromType: 'human', messageId: 'msg:one',
  at: '2026-11-03', chat: '7', chatKind: 'group', content: 'Human question', ...overrides,
});

/** What the machine's query hands `outlineOfMessages`: the message items only, in turn then item order. */
const rowsOf = (turns: readonly TranscriptTurn[]): OutlineMessageRow[] => turns.flatMap(one => one.items.flatMap(item => item.kind === 'message'
  ? [{ seq: one.seq, turnId: one.id, referenceId: one.referenceId ?? null, initiator: one.initiator, itemId: item.id, role: item.role, text: item.text }] : []));

const transcript: TranscriptTurn[] = [
  turn(0, 'user', [msg('s:turn:s0:u', 'user', '  typed ask  '), tool('s:turn:s0:t'), msg('s:turn:s0:a', 'assistant', 'first reply'), msg('s:turn:s0:b', 'assistant', 'later')]),
  // Three inputs in one provider turn; the second has no reply before the third.
  turn(1, 'user', [msg('s:turn:s1:u1', 'user', 'first'), msg('s:turn:s1:a1', 'assistant', 'first reply'),
    msg('s:turn:s1:u2', 'user', 'second'), msg('s:turn:s1:u3', 'user', 'third'), msg('s:turn:s1:a3', 'assistant', '[NO_REPLY] third reply')]),
  turn(2, 'agent', [msg('s:turn:s2:u', 'user', envelope()), msg('s:turn:s2:a', 'assistant', 'to Ada')]),
  // An agent's delivery, a system notice and a session's direct message draw nothing.
  turn(3, 'agent', [msg('s:turn:s3:u', 'user', envelope({ fromType: 'agent', from: 'Worker', fromId: 'user:worker' })), msg('s:turn:s3:a', 'assistant', 'to the worker')]),
  turn(4, 'agent', [msg('s:turn:s4:u', 'user', envelope({ route: 'system' })), msg('s:turn:s4:a', 'assistant', 'noted')]),
  // A sender of unknown type: the reader's directory decides.
  turn(5, 'agent', [msg('s:turn:s5:u', 'user', envelope({ fromType: undefined, from: 'Bo', fromId: 'user:bo', messageId: 'msg:bo' })), msg('s:turn:s5:a', 'assistant', 'to Bo')]),
  turn(6, 'agent', [msg('s:turn:s6:u', 'user', envelope({ fromType: undefined, from: 'Cy', fromId: 'user:cy', messageId: 'msg:cy' })), msg('s:turn:s6:a', 'assistant', 'to Cy')]),
  // A batch of a human and an agent: the human is shown, the reply is nobody's.
  turn(7, 'agent', [msg('s:turn:s7:u', 'user', mergeDeliveryEnvelopes([envelope({ messageId: 'msg:h', content: 'from the human' }),
    envelope({ fromType: 'agent', from: 'Worker', fromId: 'user:worker', messageId: 'msg:w', content: 'from the agent' })])),
    msg('s:turn:s7:a', 'assistant', 'to both')]),
  // Two humans in one batch: two entries, the reply on the last.
  turn(8, 'agent', [msg('s:turn:s8:u', 'user', mergeDeliveryEnvelopes([envelope({ messageId: 'msg:h1', content: 'one' }),
    envelope({ from: 'Dee', fromId: 'user:dee', messageId: 'msg:h2', content: 'two' })])), msg('s:turn:s8:a', 'assistant', 'to the two')]),
  // An agent-initiated turn whose input is plain text, and a turn with nothing to preview.
  turn(9, 'agent', [msg('s:turn:s9:u', 'user', 'not a person'), msg('s:turn:s9:a', 'assistant', 'background')]),
  turn(10, 'user', [msg('s:turn:s10:u', 'user', '   ')]),
  turn(11, 'user', [msg('s:turn:s11:u', 'user', 'with a durable id'), msg('s:turn:s11:a', 'assistant', 'ok')], 'ref-11'),
];
const self = { userId: 'me', displayName: 'Me', guguNumber: null };
const directory: TimelineRailOptions = { resolveSenderType: fromId => fromId === 'user:bo' ? 'human' : fromId === 'user:cy' ? 'agent' : undefined };

/** What an outline entry keeps of a loaded one: everything but the rows under it, which only loaded turns have. */
const comparable = (turns: ReturnType<typeof timelineTurnsFromTranscript>) => turns.map(({ itemIds: _rows, reference: _reference, ...rest }) => rest);

describe('the rail reads the same entries off an outline as off the turns', () => {
  it.each([['with a directory', directory], ['without one', {}]] as const)('%s', (_name, options) => {
    const loaded = timelineTurnsFromTranscript(transcript, self, options);
    const outlined = timelineTurnsFromOutline(outlineOfMessages(rowsOf(transcript)), self, options);
    expect(comparable(outlined)).toEqual(comparable(loaded));
    expect(loaded.length).toBeGreaterThan(6);
  });

  it('shows what the directory comes to know, without asking the machine again', () => {
    const outline = outlineOfMessages(rowsOf(transcript));
    const before = timelineTurnsFromOutline(outline, self, {}).map(one => one.prompt);
    const after = timelineTurnsFromOutline(outline, self, directory).map(one => one.prompt);
    // Ada's type came with her delivery; Bo's is known only to the directory, and Cy turns out to be an agent.
    expect(before.filter(prompt => prompt === 'Human question')).toHaveLength(1);
    expect(after.filter(prompt => prompt === 'Human question')).toHaveLength(2);
  });

  it('anchors an entry on its message and carries the reference a reveal is asked with', () => {
    const outlined = timelineTurnsFromOutline(outlineOfMessages(rowsOf(transcript)), self, directory);
    expect(outlined[0]).toMatchObject({ id: 's:turn:s0', anchorItemId: 's:turn:s0:u', itemIds: ['s:turn:s0:u'], reference: 's:turn:s0:u' });
    expect(outlined.at(-1)).toMatchObject({ id: 's:turn:s11', anchorItemId: 's:turn:s11:u', reference: 'ref-11:u' });
  });

  it('keeps previews short, whatever the message holds', () => {
    const long = 'é'.repeat(5_000);
    const [input] = outlineOfMessages(rowsOf([turn(0, 'user', [msg('u', 'user', long), msg('a', 'assistant', long)])]))[0]!.inputs;
    expect([...input!.candidates[0]!.text]).toHaveLength(OUTLINE_PROMPT_CHARS);
    expect([...input!.reply]).toHaveLength(OUTLINE_REPLY_CHARS);
  });

  it('lists no turn that has nothing a rail could show', () => {
    const outline = outlineOfMessages(rowsOf(transcript));
    expect(outline.map(one => one.seq)).toEqual([0, 1, 2, 5, 6, 7, 8, 11]);
  });
});
