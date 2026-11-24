import { rmSync } from 'node:fs';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createSessionIndexStore, openSessionIndex, readIndexState, sessionIndexPath } from './store';
import { matchTaskTurns } from '../search/task-turn-matches';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let index: ReturnType<typeof openSessionIndex> | undefined;

const turn = (id: string, text: string, endedAt?: number): TranscriptTurn => ({
  id, seq: 0, initiator: 'user', startedAt: 1, endedAt,
  items: [{ kind: 'message', id: `${id}:message:m`, seq: 0, role: 'user', text }],
});

beforeEach(async () => {
  fixture = await openFixture('empty');
  fixture.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('p', 'P', '/repo');
    INSERT INTO sessions (id, project_id, archived_at) VALUES ('s', 'p', '2026-11-23');`);
});

afterEach(() => {
  const path = sessionIndexPath(fixture.sqlite.name);
  index?.close();
  index = undefined;
  fixture.close();
  rmSync(path, { force: true });
});

it('migrates an existing archived index without reopening its record or changing the primary database', () => {
  fixture.sqlite.exec(`INSERT INTO kv (key, value) VALUES ('session-index:s', '1');
    INSERT INTO session_index_turns (session_id, turn_id, started_at) VALUES ('s', 'old', 1);
    INSERT INTO turn_text_rows (session_id, turn_id, item_id, role, text) VALUES ('s', 'old', 'item', 'user', 'archived searchable text');`);

  index = openSessionIndex(fixture.sqlite.name);
  fixture.sqlite.prepare('ATTACH DATABASE ? AS history_search').run(index.name);
  expect(readIndexState(index, 's')).toMatchObject({ retry_at: null });
  expect(matchTaskTurns(fixture.sqlite, 'searchable', undefined, undefined, 'history_search')).toMatchObject([{ archived: true, sessionId: 's' }]);
  expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM turn_text_rows').get()).toEqual({ n: 1 });
  index.close();
  index = openSessionIndex(fixture.sqlite.name);
  expect(index.prepare('SELECT count(*) AS n FROM turn_text_rows').get()).toEqual({ n: 1 });
});

it('writes only changed projections, prunes removed turns and records incomplete reads separately', () => {
  index = openSessionIndex(fixture.sqlite.name);
  const store = createSessionIndexStore(index);
  store.failed('s', 123);
  expect(readIndexState(index, 's')).toMatchObject({ retry_at: 123 });
  const first = turn('one', 'some searchable text');
  store.replace('s', [first, turn('two', 'more history')], 'first');
  expect(readIndexState(index, 's')).toEqual({ stamp: 'first', retry_at: null });
  const rowId = index.prepare('SELECT id FROM turn_text_rows WHERE turn_id = ?').pluck();
  const before = rowId.get('one');
  store.update('s', [first], []);
  expect(rowId.get('one')).toBe(before);
  expect(readIndexState(index, 's')?.stamp).toBe('first');
  store.replace('s', [first, turn('three', 'third result')], 'second');
  expect(rowId.get('one')).toBe(before);
  expect(rowId.get('two')).toBeUndefined();
  store.failed('s', 999);
  expect(readIndexState(index, 's')).toEqual({ stamp: 'second', retry_at: null });
});
