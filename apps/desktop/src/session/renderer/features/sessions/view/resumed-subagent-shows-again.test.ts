import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';

/**
 * A subagent removed from the background list with × must show again when it is resumed (Claude's SendMessage).
 * The resume reuses the transcript card that launched it and only moves the card's run start, so a removal keyed by
 * the card hid every later run for the rest of the app's life. Seen on a real session: the subagent worked for an
 * hour after a resume and the list stayed empty.
 *
 * Only the store lookup is replaced; the roster and the removal set are the real ones.
 */
const mocks = vi.hoisted(() => ({ store: {} as unknown }));
vi.mock('@renderer/features/sessions/acp/acp-chat-resource-manager', () => ({
  findAcpChatStore: () => mocks.store,
}));

const { collectSubagents } = await import('./background-task-rosters');
const { dismissSubagent, resetSubagentDismissals } = await import('./subagent-dismissals');

const SESSION = 'session-1';

function sessionWith(runStartedAt: number, agentStatus: 'running' | 'completed') {
  const launch: TranscriptTurn = {
    id: 'turn-1', seq: 0, initiator: 'user', startedAt: 100, endedAt: 200,
    outcome: { kind: 'done', reason: 'end_turn' },
    items: [{
      kind: 'spawn-subagent-tool-call', id: 'turn-1:tool:agent-1', seq: 0, toolCallId: 'agent-1', title: 'ticker',
      name: 'ticker', status: 'done', background: true, agentStatus, agentStartedAt: runStartedAt,
    }],
  } as TranscriptTurn;
  mocks.store = {
    sessionId: SESSION,
    transcriptRevision: 0,
    liveSubagentIds: agentStatus === 'running' ? ['agent-1'] : [],
    liveSubagents: [],
    chatState: { transcript: { state: { committedTurns: [launch], activeTurnSnapshot: null } } },
  };
}

const shown = () => collectSubagents(SESSION, 'subagent').map((entry) => entry.name);

describe('a removed subagent shows again when it is resumed', () => {
  beforeEach(() => resetSubagentDismissals());

  it('× removes the run that is showing', () => {
    sessionWith(1_000, 'running');
    const [entry] = collectSubagents(SESSION, 'subagent');
    dismissSubagent(SESSION, entry.id);
    expect(shown()).toEqual([]);
  });

  it('the same subagent resumed later is listed again', () => {
    sessionWith(1_000, 'running');
    dismissSubagent(SESSION, collectSubagents(SESSION, 'subagent')[0].id);
    sessionWith(1_000, 'completed');
    expect(shown()).toEqual([]);
    sessionWith(5_000, 'running');
    expect(shown()).toEqual(['ticker']);
  });

  it('the removal still holds while that run keeps going', () => {
    sessionWith(1_000, 'running');
    dismissSubagent(SESSION, collectSubagents(SESSION, 'subagent')[0].id);
    sessionWith(1_000, 'running');
    expect(shown()).toEqual([]);
  });
});
