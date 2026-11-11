import { decodeSessionUpdate } from '@gugu/session-core/acp';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const SESSION = 'session-1';
const STEP_OUTPUT = 'x'.repeat(2_000);

/**
 * #2500 measuring stick: a background subagent keeps working after the turn that launched it is committed.
 * Counts what one subagent step hands to the durable history writer.
 */
it('measures what the history writer receives per subagent step', async () => {
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

  const rows: string[] = [];
  let total = 0;
  for (const steps of [10, 100, 300, 920]) {
    const from = committed.length;
    const done = rows.length === 0 ? 0 : Number(rows.at(-1)!.split('\t')[0]);
    for (let index = done; index < steps; index += 1) {
      await send({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
        sessionUpdate: 'tool_call', toolCallId: `step-${index}`, title: `Read file ${index}`, kind: 'read', status: 'in_progress' } });
      await send({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update: {
        sessionUpdate: 'tool_call_update', toolCallId: `step-${index}`, status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: STEP_OUTPUT } }] } });
    }
    await vi.waitFor(() => expect(committed.length).toBeGreaterThan(from));
    const pushed = committed.slice(from);
    const bytes = pushed.reduce((sum, entry) => sum + entry.bytes, 0);
    total += bytes;
    rows.push([steps, pushed.length, pushed.at(-1)!.bytes, total].join('\t'));
  }
  // eslint-disable-next-line no-console
  console.log(`\nsteps\twrites in this span\tbytes of the last write\tbytes handed to the writer so far\n${rows.join('\n')}`);
  expect(committed.length).toBeGreaterThan(before);
});
