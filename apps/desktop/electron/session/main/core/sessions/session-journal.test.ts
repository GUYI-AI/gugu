import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { UNRECORDED_PROMPT } from '@gugu/session-core/acp/native-prompt';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/db/schema', () => ({ sessions: {} }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../session-timeline/locate', () => ({ sessionRecordHarnessForProvider: (provider?: string) => provider === 'codex' ? 'codex' : null }));

const { journalCommittedTurn, journalTurns } = await import('./session-journal');

beforeEach(async () => { mocks.userData = await mkdtemp(join(tmpdir(), 'journal-')); });
afterEach(async () => { await rm(mocks.userData, { recursive: true, force: true }); });

const goalLine = '/goal find ten fun places';
const committed = (meta: Record<string, unknown> | undefined): TranscriptTurn => ({
  id: 'S:turn:7', seq: 7, initiator: 'user', startedAt: 1000, endedAt: 5000, outcome: { kind: 'done' },
  items: [
    { kind: 'message', id: 'S:turn:7:message:goal:c1', seq: 0, role: 'user', text: goalLine, ...(meta ? { _meta: meta } : {}) },
    { kind: 'message', id: 'S:turn:7:message:a1', seq: 1, role: 'assistant', text: 'Here are ten places.' },
  ],
} as TranscriptTurn);

// Codex records a /goal as a thread goal, not a user message: its turn has the agent's work and no input. The person's
// line is journaled as its own turn and placed before Codex's turn, so it stays once the turn settles, on reload and on
// restart (the journal is a file the timeline reads like a record).
it('journals the input the agent keeps no record of as a turn of its own, without the agent\'s work', async () => {
  journalCommittedTurn({ sessionId: 'S', providerId: 'codex', source: 'live', turn: committed({ [UNRECORDED_PROMPT]: true }) });
  await vi.waitFor(async () => expect(await journalTurns('S')).toHaveLength(1));
  const [input] = await journalTurns('S');
  expect(input!.items).toEqual([expect.objectContaining({ role: 'user', text: goalLine })]);
  // Placed by when it started (`withJournalTurns`): before the record's turn for the work it asked for.
  expect(input!.startedAt).toBe(1000);
  expect(input!.id).not.toBe('S:turn:7');
});

it('leaves a recorded agent\'s ordinary input to its record', async () => {
  journalCommittedTurn({ sessionId: 'S', providerId: 'codex', source: 'live', turn: committed(undefined) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await journalTurns('S')).toEqual([]);
});

// A reconnect commits the same turn again; its input must still be one line of the journal, not two.
it('writes the input once when the same turn is committed twice', async () => {
  const turn = committed({ [UNRECORDED_PROMPT]: true });
  journalCommittedTurn({ sessionId: 'S', providerId: 'codex', source: 'live', turn });
  journalCommittedTurn({ sessionId: 'S', providerId: 'codex', source: 'live', turn });
  await vi.waitFor(async () => expect(await journalTurns('S')).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const lines = (await readFile(join(mocks.userData, 'session-journal', 'S.jsonl'), 'utf8')).trim().split('\n');
  expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(['S:turn:7~input@1000']);
});
