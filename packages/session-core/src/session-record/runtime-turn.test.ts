import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { endedTurnIds, withHeldTurn, withRuntimeTurn } from './runtime-turn';

const turn = (id: string, prompt: string, extra: { ended?: boolean; tool?: string; message?: string } = {}): TranscriptTurn => ({
  id, seq: 0, initiator: 'user', ...(extra.ended === false ? {} : { outcome: { kind: 'done' as const } }),
  items: [
    { kind: 'message', id: `${id}:message:u-${id}`, seq: 0, role: 'user', text: prompt },
    ...(extra.message ? [{ kind: 'message' as const, id: `${id}:message:${extra.message}`, seq: 1, role: 'assistant' as const, text: 'reply' }] : []),
    ...(extra.tool ? [{ kind: 'tool' as const, id: `${id}:tool:${extra.tool}`, seq: 2, toolCallId: extra.tool, title: 'Read', status: 'completed' as const }] : []),
  ],
} as TranscriptTurn);

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

describe('the runtime\'s last frame of a turn it ended stays until the record holds that turn closed', () => {
  const older = turn('rec-1', 'first');
  const ended = turn('S:turn:2', 'second', { ended: false, message: 'msg_2' });
  it('in place of the record\'s open copy, which can be behind it', () => {
    expect(withHeldTurn([older, turn('rec-2', 'second', { ended: false })], ended)?.map((t) => t.id)).toEqual(['rec-1', 'S:turn:2']);
  });
  it('lets go once the record holds it closed, or holds no copy of it', () => {
    expect(withHeldTurn([older, turn('rec-2', 'second', { message: 'msg_2' })], ended)).toBeNull();
    expect(withHeldTurn([older], ended)).toBeNull();
  });
  it('is not taken for an open copy by a turn that had ended before it, though it opens with the same words', () => {
    const again = turn('rec-0', 'second', { ended: false });
    expect(withHeldTurn([again], ended, new Set(['rec-0']))).toBeNull();
  });
});

describe('a timeline shows the runtime turn in progress', () => {
  it('in its snapshot and in the batch a subscriber gets, until the turn ends', async () => {
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
        expect(timeline.getSnapshot().runningTurnId).toBeNull();
        timeline.syncActiveTurn(turn('S:turn:9', 'a prompt the record has not seen yet', { ended: false }));
        expect(timeline.getSnapshot({ limit: 100 }).turns.map((t) => t.id)).toEqual([...recorded, 'S:turn:9']);
        expect(timeline.getSnapshot().runningTurnId).toBe('S:turn:9');
        const after = timeline.getAfter(cursor);
        expect(after.ok && after.batch.turns.map((t) => t.id)).toEqual(['S:turn:9']);
        expect(after.ok && after.batch.runningTurnId).toBe('S:turn:9');
        const next = timeline.getSnapshot().cursor;
        // The record holds no copy of it: nothing to hold the last frame against, the record is shown as it is.
        timeline.syncActiveTurn(null);
        expect(timeline.getSnapshot({ limit: 100 }).turns.map((t) => t.id)).toEqual(recorded);
        const removed = timeline.getAfter(next);
        expect(removed.ok && removed.batch.removedTurnIds).toEqual(['S:turn:9']);
        expect(removed.ok && removed.batch.runningTurnId).toBeNull();

      } finally { timeline.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the runtime\'s last frame of a turn it ended while the record holds that turn open', async () => {
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
        const recorded = timeline.getSnapshot({ limit: 100 }).turns;
        const open = recorded.at(-1)!;
        expect(open.outcome === undefined && open.endedAt === undefined, 'the record keeps its last turn open').toBe(true);
        // The runtime's copy of that turn, further along than the record's.
        const live: TranscriptTurn = { ...open, id: 'S:turn:9', items: [...open.items,
          { kind: 'message', id: 'S:turn:9:message:not-yet-recorded', seq: 99, role: 'assistant', text: 'the last words' }] };
        timeline.syncActiveTurn(live);
        const next = timeline.getSnapshot().cursor;
        timeline.syncActiveTurn(null);
        const shown = timeline.getSnapshot({ limit: 100 });
        expect(shown.turns.map((t) => t.id)).toEqual([...recorded.slice(0, -1).map((t) => t.id), 'S:turn:9']);
        expect(shown.turns.at(-1)?.items.at(-1)).toMatchObject({ text: 'the last words' });
        expect(shown.runningTurnId).toBeNull();
        const batch = timeline.getAfter(next);
        expect(batch.ok && batch.batch.turns, 'the frame itself did not change').toEqual([]);
        expect(batch.ok && batch.batch.runningTurnId).toBeNull();
      } finally { timeline.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reads a picture of the runtime turn from the runtime, which holds the turn whole', async () => {
    const { createSessionTimeline, emptyRecordSource, trimItemsForTransport } = await import('./index');
    const picture = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
    const whole = turn('S:turn:0', 'look at this', { ended: false, tool: 'read-1' });
    const read = { ...whole.items[1], images: [picture] };
    // What the runtime publishes: its turn trimmed for transport, the picture left as a ref.
    const published = { ...whole, items: trimItemsForTransport([whole.items[0], read] as TranscriptTurn['items']) } as TranscriptTurn;
    expect(published.items[1]).toMatchObject({ imageRefs: [{ mimeType: 'image/png', chars: picture.data.length }] });
    expect(published.items[1]).not.toHaveProperty('images');
    const asked: string[] = [];
    const timeline = await createSessionTimeline(emptyRecordSource({ harness: 'claude', providerSessionId: 'S', roots: [] }), { sessionId: 'S' });
    try {
      timeline.syncActiveTurn(published, async (itemId, index) => {
        asked.push(`${itemId}#${index}`);
        return { ok: true, image: picture };
      });
      expect(await timeline.toolImage!({ itemId: read.id, index: 0 })).toEqual({ ok: true, image: picture });
      expect(asked).toEqual([`${read.id}#0`]);
      expect(await timeline.toolImage!({ itemId: read.id, index: 0, maxChars: 4 })).toMatchObject({ ok: false, code: 'too_large' });
    } finally { timeline.dispose(); }
  });
});
