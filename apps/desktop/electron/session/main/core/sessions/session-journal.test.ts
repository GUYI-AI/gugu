import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/db/schema', () => ({ sessions: {} }));
vi.mock('../session-timeline/locate', () => ({ sessionRecordHarnessForProvider: (provider?: string) => provider === 'claude' ? 'claude' : null }));

const { appendJournalTurn, journalCommittedTurn, journalHasTurns, mergeIntoJournal, revertJournal } = await import('./session-journal');

const turn = (id: string, startedAt: number, text: string, anchor?: string): TranscriptTurn => ({
  id, seq: 0, initiator: 'user', startedAt, outcome: { kind: 'done' },
  items: [{ kind: 'message', id: `${id}:message:u`, seq: 0, role: 'user', text, ...(anchor ? { revertAnchor: anchor } : {}) }],
} as TranscriptTurn);

const lines = async () => (await readFile(join(mocks.userData, 'session-journal', 'S1.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { id: string; turn: TranscriptTurn; recorded?: true });

beforeEach(async () => { mocks.userData = await mkdtemp(join(tmpdir(), 'journal-')); });
afterEach(async () => { await rm(mocks.userData, { recursive: true, force: true }); });

describe('session journal', () => {
  it('appends whole turns, a turn again under its id', async () => {
    expect(journalHasTurns('S1')).toBe(false);
    await appendJournalTurn('S1', turn('S1:turn:0', 10, 'one'));
    await appendJournalTurn('S1', turn('S1:turn:0', 10, 'one, revised'));
    expect(journalHasTurns('S1')).toBe(true);
    expect((await lines()).map((line) => line.id)).toEqual(['S1:turn:0@10', 'S1:turn:0@10']);
  });

  it('a revert drops the anchored turn and after, and the last kept turn says how many went', async () => {
    await appendJournalTurn('S1', turn('S1:turn:0', 10, 'one'));
    await appendJournalTurn('S1', turn('S1:turn:1', 20, 'two', 'anchor-2'));
    await appendJournalTurn('S1', turn('S1:turn:2', 30, 'three'));
    await revertJournal('S1', 'anchor-2');
    const kept = await lines();
    expect(kept.map((line) => line.id)).toEqual(['S1:turn:0@10']);
    expect(JSON.stringify(kept[0]!.turn)).toContain('"effectiveValue":"2"');
    await revertJournal('S1', 'not-here');
    expect((await lines()).map((line) => line.id)).toEqual(['S1:turn:0@10']);
  });

  it('merging stored lines in twice adds them once, in time order', async () => {
    await appendJournalTurn('S1', turn('S1:turn:5', 50, 'live'));
    const stored = [{ id: 'S1:turn:1@10', at: 10, turn: turn('S1:turn:s0', 10, 'old') }, { id: 'S1:turn:5@50', at: 50, turn: turn('S1:turn:s1', 50, 'live') }];
    expect(await mergeIntoJournal('S1', stored)).toBe(1);
    expect(await mergeIntoJournal('S1', stored)).toBe(0);
    expect((await lines()).map((line) => line.id)).toEqual(['S1:turn:1@10', 'S1:turn:5@50']);
  });

  it('keeps a committed turn of an agent with a record only when it failed, marked as recorded', async () => {
    const failed = { ...turn('S1:turn:1', 20, 'two'), outcome: { kind: 'error', reason: 'process_closed', detail: 'signal=SIGKILL' } } as TranscriptTurn;
    journalCommittedTurn({ sessionId: 'S1', providerId: 'claude', source: 'live', turn: turn('S1:turn:0', 10, 'one') });
    journalCommittedTurn({ sessionId: 'S1', providerId: 'claude', source: 'revision', turn: failed });
    journalCommittedTurn({ sessionId: 'S1', providerId: 'opencode', source: 'live', turn: turn('S1:turn:2', 30, 'three') });
    await vi.waitFor(async () => expect((await lines()).map((line) => [line.id, line.recorded ?? false])).toEqual([['S1:turn:1@20', true], ['S1:turn:2@30', false]]));
  });

  it('a revert does not count a recorded turn, nor mark one', async () => {
    await appendJournalTurn('S1', turn('S1:turn:0', 10, 'one'));
    await appendJournalTurn('S1', turn('S1:turn:1', 20, 'two'), true);
    await appendJournalTurn('S1', turn('S1:turn:2', 30, 'three', 'anchor-3'));
    await appendJournalTurn('S1', turn('S1:turn:3', 40, 'four'), true);
    await revertJournal('S1', 'anchor-3');
    const kept = await lines();
    expect(kept.map((line) => line.id)).toEqual(['S1:turn:0@10', 'S1:turn:1@20']);
    expect(JSON.stringify(kept[0]!.turn)).toContain('"effectiveValue":"1"');
    expect(JSON.stringify(kept[1]!.turn)).not.toContain('effectiveValue');
  });
});
