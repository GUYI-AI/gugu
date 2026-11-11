import { describe, expect, it } from 'vitest';
import { decodeSessionUpdate } from '../acp';
import { createSessionTimeline } from './timeline';
import type { RecordEntry, SessionRecordSourceEvents, TimelineAfterResult, TimelineSubagent } from './contract';

/** #2500: a running subagent's calls travel beside the turns, as step patches. */
describe('subagent steps on the timeline', () => {
  it('sends a snapshot with the calls, then only the calls that changed, and drops the subagent when it settles', async () => {
    let sink!: SessionRecordSourceEvents;
    const source = {
      locator: { harness: 'claude' as const, providerSessionId: 'provider', roots: [] },
      start: async (events: SessionRecordSourceEvents) => { sink = events; },
      stop: () => {},
      resumePoint: async () => ({ fingerprint: 'same-source', data: {} }),
    };
    const timeline = await createSessionTimeline(source, { sessionId: 'steps' });
    try {
      let key = 0;
      const feed = async (...updates: unknown[]) => {
        sink.onEntries(updates.map((update): RecordEntry => ({
          key: `k${key += 1}`, at: Date.now() - 1_000 + key, event: decodeSessionUpdate(update as Parameters<typeof decodeSessionUpdate>[0]) })));
        await timeline.catchUp();
      };
      const child = (update: unknown) => ({ sessionUpdate: 'subagent_stream', subagentSessionId: 'child', update });
      await feed(
        { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'delegate' } },
        { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Audit', background: true },
        child({ sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read a', kind: 'read', status: 'completed' }),
        child({ sessionUpdate: 'tool_call', toolCallId: 'read-2', title: 'Read b', kind: 'read', status: 'in_progress' }),
      );
      const snapshot = timeline.getSnapshot();
      const card = snapshot.turns.flatMap((turn) => turn.items).find((item) => item.kind === 'spawn-subagent-tool-call');
      expect(card && 'children' in card ? card.children ?? [] : []).toEqual([]);
      expect(snapshot.subagents).toEqual([expect.objectContaining({ completedSteps: 1,
        steps: [expect.objectContaining({ toolCallId: 'read-1', status: 'done' }), expect.objectContaining({ toolCallId: 'read-2', status: 'running' })] })]);
      expect(snapshot.recentActions).toEqual(expect.arrayContaining(['Read']));

      const received: TimelineAfterResult[] = [];
      timeline.subscribe(snapshot.cursor, (result) => received.push(result));
      const patches = (): TimelineSubagent[] => {
        const last = received.at(-1);
        if (!last?.ok) throw new Error('expected a batch');
        return last.batch.subagents ?? [];
      };

      await feed(child({ sessionUpdate: 'tool_call_update', toolCallId: 'read-2', status: 'completed' }));
      expect(patches()).toEqual([expect.objectContaining({ completedSteps: 2, steps: [expect.objectContaining({ toolCallId: 'read-2', status: 'done' })] })]);
      // The turn that launched it did not change, so the batch carries no turn.
      const afterStep = received.at(-1);
      expect(afterStep?.ok && afterStep.batch.turns).toEqual([]);

      await feed(child({ sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: 'so far' } }));
      expect(patches()).toEqual([expect.objectContaining({ steps: [], output: 'so far' })]);

      await feed({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' });
      expect(patches()).toEqual([]);
      expect(timeline.getSnapshot().subagents).toEqual([]);
    } finally { timeline.dispose(); }
  });
});
