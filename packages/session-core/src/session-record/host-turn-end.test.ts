import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createClaudeJsonlSource } from './sources/claude-jsonl';
import { createSessionTimeline } from './timeline';
import { applyHostTurnEnd, type HostTurnEnd } from './host-turn-end';
import type { TranscriptTurn } from '../acp/models/turns/turn';

it('keeps native outcomes, unknown clocks, new turns and separate engine ends distinct', () => {
  const turn: TranscriptTurn = { id: 'one', seq: 0, initiator: 'user', startedAt: 100, items: [] };
  const ends = [{ cutoff: 200, endedAt: 200 }, { cutoff: 400, endedAt: 400 }];
  expect(applyHostTurnEnd(turn, ends)).toMatchObject({ outcome: { kind: 'cancelled' }, endedAt: 200 });
  expect(applyHostTurnEnd({ ...turn, startedAt: 300 }, ends).endedAt).toBe(400);
  const newer = { ...turn, startedAt: 500 };
  expect(applyHostTurnEnd(newer, ends)).toBe(newer);
  const unknown = { ...turn, startedAt: undefined };
  expect(applyHostTurnEnd(unknown, ends)).toBe(unknown);
  const done = { ...turn, outcome: { kind: 'done' as const, reason: 'end_turn' as const }, endedAt: 150 };
  expect(applyHostTurnEnd(done, ends)).toBe(done);
  expect(applyHostTurnEnd(turn, [{ cutoff: 200 }])).toMatchObject({ outcome: { kind: 'cancelled' } });
  expect(applyHostTurnEnd(turn, [{ cutoff: 200 }]).endedAt).toBeUndefined();
});

it('ends an actual unfinished Claude record in snapshot, delta and reopen without editing the native file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-pty-end3374-'));
  const project = join(root, 'project'); await mkdir(project);
  const providerSessionId = '33740000-0000-4000-8000-000000000001';
  const file = join(project, providerSessionId + '.jsonl');
  const at = Date.parse('2026-11-20T03:28:51Z');
  const user = (uuid: string, time: number, parentUuid: string | null) => JSON.stringify({ type: 'user', uuid, parentUuid,
    sessionId: providerSessionId, timestamp: new Date(time).toISOString(), message: { role: 'user', content: 'test request' } }) + '\n';
  const original = user('first', at, null) + JSON.stringify({ type: 'assistant', uuid: 'question', parentUuid: 'first',
    sessionId: providerSessionId, timestamp: new Date(at + 1).toISOString(), message: { id: 'question', role: 'assistant',
      content: [{ type: 'tool_use', id: 'ask-3374', name: 'AskUserQuestion', input: { questions: [
        { question: 'Test question?', header: 'Test', options: [{ label: 'Yes', description: 'Test yes' }, { label: 'No', description: 'Test no' }], multiSelect: false },
      ] } }], stop_reason: 'tool_use' } }) + '\n';
  await writeFile(file, original);
  let ends: HostTurnEnd[] = [];
  const listeners = new Set<() => void>();
  const deps = { sessionId: 'test-3374', hostTurnEnds: { read: () => ends,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } };
  const open = () => createSessionTimeline(createClaudeJsonlSource({ harness: 'claude', providerSessionId, roots: [root] }, { pollIntervalMs: 20 }), deps);
  let timeline = await open();
  try {
    const before = timeline.getSnapshot();
    expect(before.turns.at(-1)?.outcome).toBeUndefined();
    expect(before.settlements.some(one => one.state === 'pending')).toBe(true);
    const closedAt = at + 10 * 60_000;
    ends = [{ cutoff: closedAt, endedAt: closedAt }];
    for (const listener of listeners) listener();
    const ended = timeline.getSnapshot().turns.at(-1)!;
    expect(ended).toMatchObject({ outcome: { kind: 'cancelled' }, endedAt: closedAt, hostEnd: { at: closedAt } });
    expect(timeline.getSnapshot().settlements.every(one => one.state !== 'pending')).toBe(true);
    expect(timeline.getAfter(before.cursor)).toMatchObject({ ok: true, batch: { turns: [expect.objectContaining({ outcome: { kind: 'cancelled', reason: 'cancelled' }, endedAt: closedAt })] } });
    timeline.dispose(); expect(listeners.size).toBe(0);
    timeline = await open();
    expect(timeline.getSnapshot().turns.at(-1)).toEqual(ended);
    // A genuinely later native reply remains authoritative, rather than inheriting the host cancellation.
    await appendFile(file, JSON.stringify({ type: 'assistant', uuid: 'reply', parentUuid: 'question', sessionId: providerSessionId,
      timestamp: new Date(closedAt + 1).toISOString(), message: { id: 'reply', role: 'assistant',
        content: [{ type: 'text', text: 'late native answer' }], stop_reason: 'end_turn' } }) + '\n');
    await vi.waitFor(() => expect(timeline.getSnapshot().turns.at(-1)?.outcome?.kind).toBe('done'));
    await appendFile(file, user('next', closedAt + 1000, 'reply'));
    await vi.waitFor(() => expect(timeline.getSnapshot().turns).toHaveLength(2));
    expect(timeline.getSnapshot().turns.at(-1)?.outcome).toBeUndefined();
  } finally { timeline.dispose(); await rm(root, { recursive: true, force: true }); }
});
