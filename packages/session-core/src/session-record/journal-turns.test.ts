import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { createSessionRecordSource, createSessionTimeline, emptyRecordSource } from './index';
import { withJournalTurns } from './journal-turns';

const turn = (id: string, startedAt: number | undefined, text = id): TranscriptTurn => ({
  id, seq: 0, initiator: 'agent', ...(startedAt !== undefined ? { startedAt } : {}), outcome: { kind: 'done' },
  items: [{ kind: 'message', id: `${id}:message:m`, seq: 0, role: 'assistant', text }],
} as TranscriptTurn);
const ids = (turns: readonly TranscriptTurn[]) => turns.map((t) => t.id);

describe('journal turns go among the record turns by when they started', () => {
  it('before the first record turn that started after them', () => {
    expect(ids(withJournalTurns([turn('r1', 10), turn('r2', 30)], [turn('j1', 20), turn('j2', 40)]))).toEqual(['r1', 'j1', 'r2', 'j2']);
  });
  it('a record turn with no start stays where it is; an equal start keeps the record turn first', () => {
    expect(ids(withJournalTurns([turn('r1', 10), turn('r2', undefined), turn('r3', 20)], [turn('j1', 20)]))).toEqual(['r1', 'r2', 'r3', 'j1']);
  });
  it('a journal alone is the whole history', () => {
    expect(ids(withJournalTurns([], [turn('j1', 1), turn('j2', 2)]))).toEqual(['j1', 'j2']);
  });
});

describe('a recorded journal turn gives its outcome to the record turn it is', () => {
  /** A turn whose agent message is `message`: the id an agent numbered, the same in its record and its runtime. */
  const said = (id: string, startedAt: number, message: string): TranscriptTurn => ({
    ...turn(id, startedAt), items: [{ kind: 'message', id: `${id}:message:${message}`, seq: 0, role: 'assistant', text: message }],
  } as TranscriptTurn);
  const failed = (id: string, startedAt: number, message: string): TranscriptTurn => ({ ...said(id, startedAt, message), outcome: { kind: 'error', reason: 'process_closed', detail: 'signal=SIGKILL' } } as TranscriptTurn);
  const asked = (id: string, startedAt: number, prompt: string): TranscriptTurn => ({
    id, seq: 0, initiator: 'user', startedAt, items: [{ kind: 'message', id: `${id}:message:u`, seq: 0, role: 'user', text: prompt }],
  } as TranscriptTurn);
  it('by a shared message id: only the outcome changes, the record turn stays where and what it is', () => {
    const out = withJournalTurns([said('r1', 10, 'a'), said('r2', 20, 'b')], [], [failed('runtime-9', 19, 'b')]);
    expect(ids(out)).toEqual(['r1', 'r2']);
    expect(out[1]!.outcome).toMatchObject({ reason: 'process_closed' });
    expect(out[0]!.outcome).toEqual({ kind: 'done' });
  });
  it('by its opening prompt, when the record numbers its own lines', () => {
    const out = withJournalTurns([asked('rec:1', 10, 'run  sleep 300')], [], [{ ...asked('runtime-1', 9, 'run sleep 300'), outcome: { kind: 'error', reason: 'prompt_failed', detail: 'x' } } as TranscriptTurn]);
    expect(ids(out)).toEqual(['rec:1']);
    expect(out[0]!.outcome).toMatchObject({ reason: 'prompt_failed' });
  });
  it('one the record does not hold is shown whole, by when it started', () => {
    expect(ids(withJournalTurns([said('r1', 10, 'a'), said('r2', 30, 'b')], [turn('j1', 40)], [failed('runtime-9', 20, 'never-written')]))).toEqual(['r1', 'runtime-9', 'r2', 'j1']);
  });
});

describe('a timeline reads the journal beside the record', () => {
  it('places a notification by time, and takes a line appended later', async () => {
    const text = await readFile(new URL('./__fixtures__/claude-session.jsonl', import.meta.url), 'utf8');
    const id = text.split('\n').map((line) => { try { return (JSON.parse(line) as { sessionId?: string }).sessionId; } catch { return undefined; } }).find(Boolean)!;
    const root = await mkdtemp(join(tmpdir(), 'journal-timeline-'));
    try {
      await mkdir(join(root, 'project'), { recursive: true });
      await mkdir(join(root, 'journal'), { recursive: true });
      await writeFile(join(root, 'project', `${id}.jsonl`), text);
      const journalFile = join(root, 'journal', 'S.jsonl');
      await writeFile(journalFile, '');
      const journal = { harness: 'gugu' as const, providerSessionId: 'S', roots: [join(root, 'journal')] };
      const timeline = await createSessionTimeline(createSessionRecordSource({ harness: 'claude', providerSessionId: id, roots: [root] }), {
        sessionId: 'S', journal: createSessionRecordSource(journal, { pollIntervalMs: 20 }),
      });
      try {
        const recorded = timeline.getSnapshot({ limit: 100 }).turns;
        expect(recorded.length).toBeGreaterThan(1);
        const between = recorded[1]!.startedAt! - 1;
        await appendFile(journalFile, `${JSON.stringify({ id: 'owner-notify:1@x', at: between, turn: turn('ignored', between, 'notice') })}\n`);
        await timeline.catchUp();
        const placed = timeline.getSnapshot({ limit: 100 }).turns;
        expect(ids(placed)).toEqual([recorded[0]!.id, 'owner-notify:1@x', ...ids(recorded.slice(1))]);
        // Readers order turns by seq: the notification's own 0 gives way to its place.
        expect(placed.map((t) => t.seq)).toEqual(placed.map((_, index) => recorded[0]!.seq + index));
        // The runtime's verdict on a recorded turn (the engine died in it): the same turns, that one ended so.
        const verdict = { ...recorded[0]!, id: 'runtime-turn-0', outcome: { kind: 'error', reason: 'process_closed', detail: 'signal=SIGKILL' } };
        await appendFile(journalFile, `${JSON.stringify({ id: 'runtime-turn-0@1', at: verdict.startedAt ?? 0, turn: verdict, recorded: true })}\n`);
        await timeline.catchUp();
        const after = timeline.getSnapshot({ limit: 100 }).turns;
        expect(ids(after)).toEqual([recorded[0]!.id, 'owner-notify:1@x', ...ids(recorded.slice(1))]);
        expect(after[0]!.outcome).toMatchObject({ kind: 'error', reason: 'process_closed' });
      } finally { timeline.dispose(); }
      const only = await createSessionTimeline(emptyRecordSource(journal), { sessionId: 'S', journal: createSessionRecordSource(journal) });
      // No record to give its outcome to: the recorded turn is shown whole.
      try { expect(ids(only.getSnapshot({ limit: 100 }).turns)).toEqual(['runtime-turn-0@1', 'owner-notify:1@x']); } finally { only.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
