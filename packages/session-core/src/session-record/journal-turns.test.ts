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
        expect(ids(timeline.getSnapshot({ limit: 100 }).turns)).toEqual([recorded[0]!.id, 'owner-notify:1@x', ...ids(recorded.slice(1))]);
      } finally { timeline.dispose(); }
      const only = await createSessionTimeline(emptyRecordSource(journal), { sessionId: 'S', journal: createSessionRecordSource(journal) });
      try { expect(ids(only.getSnapshot({ limit: 100 }).turns)).toEqual(['owner-notify:1@x']); } finally { only.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
