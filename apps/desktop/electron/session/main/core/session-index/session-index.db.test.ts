import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { SessionTimeline, TimelineAfterResult } from '@gugu/session-core/session-record';

const fixtureRef = vi.hoisted(() => ({ current: undefined as Awaited<ReturnType<typeof openFixture>> | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return fixtureRef.current!.db; }, get sqlite() { return fixtureRef.current!.sqlite; } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { followSessionIndex, indexedTurnCount, lastIndexedTurn, sessionIndexed } = await import('./session-index');

const turn = (id: string, startedAt: number, outcome?: TranscriptTurn['outcome']): TranscriptTurn => ({
  id, seq: 0, initiator: 'user', startedAt, ...(outcome ? { outcome } : {}),
  items: [{ kind: 'message', id: `${id}:message:m`, seq: 0, role: 'user', text: `said in ${id}` }],
} as TranscriptTurn);

/** A timeline as the index follows it: a snapshot, then the batches it pushes. */
function timeline(initial: TranscriptTurn[]) {
  let turns = initial;
  let listener: ((result: TimelineAfterResult) => void) | null = null;
  const value = {
    getSnapshot: () => ({ cursor: { epoch: 'e', seq: 0 }, turns, settlements: [], hasOlder: false }),
    subscribe: (_cursor: unknown, next: (result: TimelineAfterResult) => void) => { listener = next; return () => { listener = null; }; },
  } as unknown as SessionTimeline;
  return {
    value,
    push: (changed: TranscriptTurn[], removedTurnIds: string[] = []) => {
      const byId = new Map(turns.map((one) => [one.id, one]));
      for (const id of removedTurnIds) byId.delete(id);
      for (const one of changed) byId.set(one.id, one);
      turns = [...byId.values()];
      listener!({ ok: true, batch: { turns: changed, removedTurnIds, settlements: [] } } as unknown as TimelineAfterResult);
    },
    reset: (next: TranscriptTurn[]) => {
      turns = next;
      listener!({ ok: false, reset: 'epoch_changed', snapshot: value.getSnapshot() } as unknown as TimelineAfterResult);
    },
  };
}

beforeEach(async () => {
  fixtureRef.current = await openFixture('empty');
  fixtureRef.current.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('p', 'P', '/repo');
    INSERT INTO sessions (id, project_id, config) VALUES ('s', 'p', '{"version":"1","type":"acp"}');`);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fixtureRef.current?.close();
  fixtureRef.current = undefined;
});

it('writes the whole timeline when it opens, then what each batch changed, a burst at a time', () => {
  const t = timeline([turn('a', 1), turn('b', 2)]);
  expect(sessionIndexed('s')).toBe(false);
  const stop = followSessionIndex('s', t.value);
  expect(sessionIndexed('s')).toBe(true);
  expect(indexedTurnCount('s')).toBe(2);

  t.push([turn('c', 3)]);
  t.push([turn('c', 3, { kind: 'error', reason: 'process_closed', detail: 'signal=SIGKILL' })]);
  expect(indexedTurnCount('s'), 'a burst is written once it settles').toBe(2);
  vi.advanceTimersByTime(600);
  expect(indexedTurnCount('s')).toBe(3);
  expect(lastIndexedTurn('s')).toMatchObject({ turn_id: 'c', outcome_kind: 'error', outcome_message: 'signal=SIGKILL' });

  t.push([], ['c']);
  stop();
  expect(indexedTurnCount('s'), 'what is pending is written when following stops').toBe(2);
});

it('writes it all again after a reset', () => {
  const t = timeline([turn('a', 1), turn('b', 2)]);
  const stop = followSessionIndex('s', t.value);
  t.reset([turn('x', 5)]);
  vi.advanceTimersByTime(600);
  expect(indexedTurnCount('s')).toBe(1);
  expect(lastIndexedTurn('s')?.turn_id).toBe('x');
  stop();
});
