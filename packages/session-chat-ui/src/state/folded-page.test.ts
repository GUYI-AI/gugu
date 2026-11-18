import { describe, expect, it } from 'vitest';
import { trimCursorPageForTransport, TRANSPORT_PAYLOAD_BUDGET, TRANSPORT_TEXT_LIMIT } from '@gugu/session-core/session-record';
import { turnHeld } from '@gugu/session-core/session-record/held-turn';
import { defaultChatTranslator as translate } from '../localization';
import { unit, type ItemSegmenter, type RenderUnit, type SegmentCtx } from '../core/units';
import type { TranscriptTurn } from '../model';
import { flattenTier } from './flatten';

// A folded page (transport-trim `folded-form`) leaves out what stands behind a fold, on the promise that the folded
// conversation looks the same. This is that promise, held against the code the conversation is laid out with.
const AGENT = 'user:11111111-1111-4111-8111-111111111111';
const segmenters = new Proxy({}, { get: (_target, kind: string) => ({ kind, segment: (item: unknown) => [unit(kind, item as never, item as never, { key: 'self' })] }) }) as Record<string, ItemSegmenter>;
const ctx = (knowsAgents: boolean) => ({ actor: (id: string) => knowsAgents && id === AGENT ? { id, type: 'agent', name: 'd3' } : null, chatName: () => null, translate,
  agentConversation: true, active: false, expanded: () => false, pendingToolCallIds: () => new Set(), terminalSnapshot: () => null, plan: () => null, caches: {} }) as unknown as SegmentCtx;

const id = (seq: number, tail: string) => `s:turn:s${seq}:${tail}`;
const said = (seq: number, tail: string, text: string) => ({ kind: 'message', id: id(seq, tail), seq: 9, role: 'assistant', text });
const step = (seq: number, tail: string, fields: Record<string, unknown> = {}) => ({ kind: 'execute-tool-call', id: id(seq, tail), seq: 2, toolCallId: tail, title: 'Run the tests',
  status: 'done', command: 'pnpm test --run', rawInput: '{"command":"pnpm test --run"}', outputText: 'o'.repeat(900), ...fields });
const delivery = (seq: number, body: string) => ({ kind: 'message', id: id(seq, 'message:in'), seq: 0, role: 'user', text:
  `<gugu_delivery route="chat" chat="dm-1" chat_kind="dm" from="d3" from_id="${AGENT}" from_type="agent" msg="msg:0000000${seq}-0000-4000-8000-000000000000">\n  <message_context><![CDATA[${'c'.repeat(400)}]]></message_context>\n<![CDATA[${body}]]>\n  <arrival>reply with message_send</arrival>\n</gugu_delivery>` });
const send = (seq: number, text: string) => ({ kind: 'mcp-tool-call', id: id(seq, 'tool:send'), seq: 3, toolCallId: `send${seq}`, server: 'gugu', tool: 'message_send', status: 'done', title: 'message_send',
  rawInput: JSON.stringify({ chat_id: 'dm-1', to_user_ids: [AGENT], text }), outputText: `sent (id=msg:aaaaaaa${seq}-aaaa-4aaa-8aaa-aaaaaaaaaaaa)` });
const turn = (seq: number, items: unknown[]): TranscriptTurn => ({ id: `s:turn:s${seq}`, seq, initiator: 'user', startedAt: 1_000 * seq, endedAt: 1_000 * seq + 500, outcome: { kind: 'done' }, items } as unknown as TranscriptTurn);

const conversation = [
  // The person asks; the agent thinks, works, and answers.
  turn(1, [{ kind: 'message', id: id(1, 'message:u'), seq: 0, role: 'user', text: 'Please run the tests' },
    { kind: 'thinking', id: id(1, 'thinking:t'), seq: 1, text: 'They want the whole suite. '.repeat(20), status: 'done' },
    step(1, 'tool:a'), said(1, 'message:mid', 'Running them now.'), step(1, 'tool:b', { status: 'error', outputText: 'exit 1' }), said(1, 'message:r', 'One test fails: the date one.')]),
  // Another agent writes; the agent works, answers it, and has nothing to say here.
  turn(2, [delivery(2, 'How far along is the release? '.repeat(30)), step(2, 'tool:a'), send(2, 'Two items left, both small. '.repeat(30)), said(2, 'message:silent', '[NO_REPLY]')]),
  turn(3, [delivery(3, 'Thanks. '.repeat(40)), send(3, 'You are welcome. '.repeat(20)), said(3, 'message:silent', '[NO_REPLY]')]),
  // The person again.
  turn(4, [{ kind: 'message', id: id(4, 'message:u'), seq: 0, role: 'user', text: 'And now?' }, step(4, 'tool:a'), said(4, 'message:r', 'All green.')]),
];
const folded = trimCursorPageForTransport({ turns: conversation, nextCursor: null }, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, 'folded').turns;

/** What is on screen with every fold closed: rows outside any exchange, and each exchange's own line. */
const onScreen = (turns: readonly TranscriptTurn[], context: SegmentCtx) =>
  flattenTier(turns, context, segmenters).filter(row => !row.activityFold || row.kind === 'agent-activity');
/** A row as drawn. A reply's head row draws the name and the process line, not the sent message it carries. */
function drawn(row: RenderUnit): unknown {
  const { activityGroup: _group, ...data } = row.data as Record<string, unknown>;
  if (data.conversationPart === 'head') delete data.sentMessages;
  return JSON.parse(JSON.stringify({ id: row.id, kind: row.kind, gap: row.gapBefore, data }));
}

describe('a conversation laid out from a folded page', () => {
  it('is sent as less: steps, thoughts, deliveries from agents and sends to them are held', () => {
    expect(JSON.stringify(folded).length).toBeLessThan(JSON.stringify(conversation).length / 2);
    expect(folded.map(turnHeld)).toEqual([true, true, true, true]);
  });

  it('shows the same rows, with every fold closed, as one laid out from the whole turns', () => {
    const whole = onScreen(conversation, ctx(true)), sent = onScreen(folded, ctx(true));
    expect(sent.map(drawn)).toEqual(whole.map(drawn));
    // Not vacuous: the person's words, both replies, both process lines and one exchange are there.
    expect(whole.map(row => row.kind)).toEqual(expect.arrayContaining(['message', 'agent-activity']));
    expect(whole.filter(row => row.kind === 'agent-activity')).toHaveLength(1);
    expect(sent.some(row => (row.data as { held?: true }).held === true)).toBe(false);
  });

  it('marks every row that would be drawn short when the reader folds less than this side guessed', () => {
    // A reader whose directory does not know the sender an agent draws its messages, and the answers to it, in the open.
    const whole = onScreen(conversation, ctx(false)), sent = onScreen(folded, ctx(false));
    expect(sent.map(row => row.id)).toEqual(whole.map(row => row.id));
    const short = sent.filter((row, index) => JSON.stringify(drawn(row)) !== JSON.stringify(drawn(whole[index]!)));
    expect(short.length).toBeGreaterThan(0);
    // Each says so (`held`): on screen, it has its turn read again.
    expect(short.every(row => (row.data as { held?: true }).held === true)).toBe(true);
  });
});
