import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { endedTurnIds, recordHolds, withDrawnTurns } from './runtime-turn';

const withRuntimeTurn = (turns: readonly TranscriptTurn[], runtime: TranscriptTurn | null, before: ReadonlySet<string> = new Set()) =>
  withDrawnTurns(turns, runtime ? [{ turn: runtime, before }] : []);

const turn = (id: string, prompt: string, extra: { ended?: boolean; tool?: string; message?: string } = {}): TranscriptTurn => ({
  id, seq: 0, initiator: 'user', ...(extra.ended === false ? {} : { outcome: { kind: 'done' as const } }),
  items: [
    { kind: 'message', id: `${id}:message:u-${id}`, seq: 0, role: 'user', text: prompt },
    ...(extra.message ? [{ kind: 'message' as const, id: `${id}:message:${extra.message}`, seq: 1, role: 'assistant' as const, text: 'reply' }] : []),
    ...(extra.tool ? [{ kind: 'tool' as const, id: `${id}:tool:${extra.tool}`, seq: 2, toolCallId: extra.tool, title: 'Read', status: 'completed' as const }] : []),
  ],
} as TranscriptTurn);

describe('a turn its runtime ended is shown until the record holds it', () => {
  const none = new Set<string>();
  const ended = turn('S:turn:1', 'second', { tool: 'call-2' });
  it('is held by an ended copy, read to now or not', () => {
    expect(recordHolds([turn('rec-2', 'second')], { turn: ended, before: none }, false)).toBe(true);
  });
  it('is not held by an open copy until the record was read as written at that end', () => {
    const open = turn('rec-2', 'second', { ended: false });
    expect(recordHolds([open], { turn: ended, before: none }, false)).toBe(false);
    expect(recordHolds([open], { turn: ended, before: none }, true)).toBe(true);
  });
  it('is not held by a record without it, however far that was read, nor by a turn that had ended when it started', () => {
    expect(recordHolds([], { turn: ended, before: none }, true)).toBe(false);
    expect(recordHolds([turn('rec-1', 'second')], { turn: ended, before: new Set(['rec-1']) }, true)).toBe(false);
  });
  it('is held by a later turn of a record that shares nothing with it, by when each started', () => {
    const at = (one: TranscriptTurn, startedAt: number): TranscriptTurn => ({ ...one, startedAt });
    const held = { turn: at(ended, 10), before: none };
    expect(recordHolds([at(turn('rec-2', 'worded its own way'), 12)], held, true)).toBe(true);
    expect(recordHolds([at(turn('rec-2', 'worded its own way'), 5)], held, true)).toBe(false);
    expect(recordHolds([at(turn('rec-2', 'worded its own way'), 12)], held, false)).toBe(false);
  });
  it('draws held turns and the running one, oldest first, each in place of its copies', () => {
    const first = turn('S:turn:1', 'first', { tool: 'call-1' });
    const running = turn('S:turn:2', 'second', { ended: false });
    const record = [turn('rec-0', 'zero'), turn('rec-1', 'first', { ended: false, tool: 'call-1' }), turn('rec-2', 'second', { ended: false })];
    expect(withDrawnTurns(record, [{ turn: first, before: none }, { turn: running, before: none }]).map((t) => t.id)).toEqual(['rec-0', 'S:turn:1', 'S:turn:2']);
  });
});

describe('the runtime turn in progress replaces the record copy of it', () => {
  const older = turn('rec-1', 'first', { tool: 'call-1' });
  it('shows the record as it is when no turn is in progress', () => {
    expect(withRuntimeTurn([older], null)).toEqual([older]);
  });
  it('replaces the open turn at the tail of the record that is this turn, and not an open turn that is another one', () => {
    const live = turn('S:turn:1', 'second', { ended: false });
    expect(withRuntimeTurn([older, turn('rec-2', 'second', { ended: false })], live).map((t) => t.id)).toEqual(['rec-1', 'S:turn:1']);
    expect(withRuntimeTurn([older, turn('rec-2', 'before', { ended: false })], live).map((t) => t.id)).toEqual(['rec-1', 'rec-2', 'S:turn:1']);
  });
  it('replaces an ended record turn that shares a tool call or a message id', () => {
    const live = turn('S:turn:1', 'reworded by the harness', { ended: false, tool: 'call-2' });
    expect(withRuntimeTurn([older, turn('rec-2', 'second', { tool: 'call-2' })], live).map((t) => t.id)).toEqual(['rec-1', 'S:turn:1']);
    const byMessage = turn('S:turn:1', 'x', { ended: false, message: 'msg_9' });
    expect(withRuntimeTurn([older, turn('rec-2', 'y', { message: 'msg_9' })], byMessage).map((t) => t.id)).toEqual(['rec-1', 'S:turn:1']);
  });
  it('replaces an ended record turn opened by the same prompt when no id is shared', () => {
    const live = turn('S:turn:1', 'fix  the\nbug', { ended: false, tool: 'exec-1' });
    expect(withRuntimeTurn([older, turn('rec-2', 'fix the bug', { tool: 'call_1' })], live).map((t) => t.id)).toEqual(['rec-1', 'S:turn:1']);
  });
  it('keeps a turn that had ended when this one started, though it opens with the same words', () => {
    const again = turn('rec-2', 'same words');
    const live = turn('S:turn:3', 'same words', { ended: false });
    expect(withRuntimeTurn([older, again], live, endedTurnIds([older, again])).map((t) => t.id)).toEqual(['rec-1', 'rec-2', 'S:turn:3']);
    // Its own copy, written once it had started, still steps aside.
    expect(withRuntimeTurn([older, again, turn('rec-3', 'same words')], live, endedTurnIds([older, again])).map((t) => t.id)).toEqual(['rec-1', 'rec-2', 'S:turn:3']);
  });
  it('keeps an ended turn that is not this one, and everything before it', () => {
    const live = turn('S:turn:2', 'third', { ended: false, tool: 'call-1' });
    const records = [older, turn('rec-2', 'second', { tool: 'call-x' })];
    expect(withRuntimeTurn(records, live).map((t) => t.id)).toEqual(['rec-1', 'rec-2', 'S:turn:2']);
  });
});

describe('a timeline shows the runtime turn in progress', () => {
  it('in its snapshot and in the batch a subscriber gets, and after it ends until the record holds it', async () => {
    const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createSessionRecordSource, createSessionTimeline } = await import('./index');
    const text = await readFile(new URL('./__fixtures__/claude-session.jsonl', import.meta.url), 'utf8');
    const id = text.split('\n').map((line) => { try { return (JSON.parse(line) as { sessionId?: string }).sessionId; } catch { return undefined; } }).find(Boolean)!;
    const root = await mkdtemp(join(tmpdir(), 'runtime-turn-'));
    try {
      await mkdir(join(root, 'project'), { recursive: true });
      await writeFile(join(root, 'project', `${id}.jsonl`), text);
      const timeline = await createSessionTimeline(createSessionRecordSource({ harness: 'claude', providerSessionId: id, roots: [root] }), { sessionId: 'S' });
      try {
        const recorded = timeline.getSnapshot({ limit: 100 }).turns.map((t) => t.id);
        const cursor = timeline.getSnapshot().cursor;
        timeline.syncActiveTurn(turn('S:turn:9', 'a prompt the record has not seen yet', { ended: false }));
        expect(timeline.getSnapshot({ limit: 100 }).turns.map((t) => t.id)).toEqual([...recorded, 'S:turn:9']);
        const after = timeline.getAfter(cursor);
        expect(after.ok && after.batch.turns.map((t) => t.id)).toEqual(['S:turn:9']);
        const next = timeline.getSnapshot().cursor;
        // Ended by its runtime and not in the record: it stays, read to now or not, until the record holds it.
        timeline.syncActiveTurn(null);
        await timeline.catchUp();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(timeline.getSnapshot({ limit: 100 }).turns.map((t) => t.id)).toEqual([...recorded, 'S:turn:9']);
        const kept = timeline.getAfter(next);
        expect(kept.ok && kept.batch.removedTurnIds).toEqual([]);

      } finally { timeline.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
