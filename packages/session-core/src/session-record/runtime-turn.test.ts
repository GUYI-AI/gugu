import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { withRuntimeTurn } from './runtime-turn';

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
  it('keeps an ended turn that is not this one, and everything before it', () => {
    const live = turn('S:turn:2', 'third', { ended: false, tool: 'call-1' });
    const records = [older, turn('rec-2', 'second', { tool: 'call-x' })];
    expect(withRuntimeTurn(records, live).map((t) => t.id)).toEqual(['rec-1', 'rec-2', 'S:turn:2']);
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
        timeline.syncActiveTurn(turn('S:turn:9', 'a prompt the record has not seen yet', { ended: false }));
        expect(timeline.getSnapshot({ limit: 100 }).turns.map((t) => t.id)).toEqual([...recorded, 'S:turn:9']);
        const after = timeline.getAfter(cursor);
        expect(after.ok && after.batch.turns.map((t) => t.id)).toEqual(['S:turn:9']);
        const next = timeline.getSnapshot().cursor;
        timeline.syncActiveTurn(null);
        expect(timeline.getSnapshot({ limit: 100 }).turns.map((t) => t.id)).toEqual(recorded);
        const removed = timeline.getAfter(next);
        expect(removed.ok && removed.batch.removedTurnIds).toEqual(['S:turn:9']);
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
