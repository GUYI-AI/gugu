import { decodeSessionUpdate } from '@gugu/session-core/acp';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const SESSION = 'session-1';
const STEP_OUTPUT = 'x'.repeat(2_000);

/**
 * #2500. A background subagent keeps working after the turn that launched it is committed. Its calls go to the
 * subagent registry; the launching turn is handed to the history writer again only when the card itself changes.
 * Before the change every call rewrote the whole turn: 920 calls of 2 KB handed the writer 3.6 GB in 1840 writes.
 */
it('hands the history writer nothing per subagent call, and the launching turn once when the subagent settles', async () => {
  const committed: Array<{ source: string; turn: TranscriptTurn; bytes: number }> = [];
  const h = makeAcpHarness({
    onTurnCommitted: ({ source, turn }) => committed.push({ source, turn, bytes: JSON.stringify(turn).length }),
  });
  const rt = new AcpRuntime(h.deps);
  expect((await rt.startSession(makeStartInput({ sessionId: 'cost' }))).success).toBe(true);
  const client = h.client();
  const send = (update: unknown) => client.sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(update as SessionUpdate) });
  const answers: Array<(value: { stopReason: string }) => void> = [];
  h.agent.prompt = vi.fn().mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
  const turn = async (prompt: string, during: () => unknown) => {
    const index = answers.length;
    const done = rt.sendPrompt('cost', { text: prompt });
    await h.agent.called('prompt', index + 1);
    await during();
    answers[index]!({ stopReason: 'end_turn' });
    await done;
  };
  await turn('delegate', () => send({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Audit', background: true }));
  await turn('anything else?', () => send({ sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: 'waiting' } }));
  const before = committed.length;

  for (let index = 0; index < 300; index += 1) {
    await send({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
      sessionUpdate: 'tool_call', toolCallId: `step-${index}`, title: `Read file ${index}`, kind: 'read', status: 'in_progress' } });
    await send({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
      sessionUpdate: 'tool_call_update', toolCallId: `step-${index}`, status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: STEP_OUTPUT } }] } });
  }
  await send({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
    sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'CHILD_RESULT' } } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(committed.slice(before), 'no call and no running text reaches the writer').toEqual([]);

  await send({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' });
  await vi.waitFor(() => expect(committed.length).toBeGreaterThan(before));
  const settled = committed.slice(before);
  expect(settled.map((entry) => entry.source)).toEqual(['backfill']);
  const card = settled[0]!.turn.items.find((item) => item.kind === 'spawn-subagent-tool-call');
  expect(card).toMatchObject({ agentStatus: 'completed', outputText: 'CHILD_RESULT' });
  expect(card && 'children' in card ? card.children ?? [] : []).toEqual([]);
  // 300 calls of 2 KB each would be 600 KB inside the turn.
  expect(settled[0]!.bytes).toBeLessThan(8_000);
});
