import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const test = vi.hoisted(() => ({
  fixture: undefined as Awaited<ReturnType<typeof openFixture>> | undefined,
  backfill: vi.fn(async (_id: string, _respectRetry: boolean) => 'indexed'),
  due: vi.fn((id: string) => id !== 'indexed' && id !== 'deferred'),
  indexed: vi.fn((id: string) => id === 'indexed'),
}));

vi.mock('@main/db/client', () => ({ get sqlite() { return test.fixture!.sqlite; } }));
vi.mock('../session-timeline/service', () => ({ backfillSessionIndex: test.backfill }));
vi.mock('./session-index', () => ({
  prepareSessionIndex: async () => 'ready',
  sessionIndexDue: test.due,
  sessionIndexed: test.indexed,
  removeSessionFromIndex: vi.fn(),
}));

import type { Session } from '@shared/core/sessions/sessions';
import { sessionEvents } from '../sessions/session-events';
import { indexSessionsInBackground, stopSessionIndexBackfill } from './background';

beforeEach(async () => {
  test.fixture = await openFixture('empty');
  test.backfill.mockClear();
  test.fixture.sqlite.exec(`
    INSERT INTO projects (id, name, path, workspace_provider) VALUES
      ('local', 'Local', '/local', 'local'), ('remote', 'Remote', '/remote', 'ssh');
    INSERT INTO sessions (id, project_id, archived_at, updated_at) VALUES
      ('older', 'local', NULL, '2026-11-21'),
      ('newer', 'local', NULL, '2026-11-22'),
      ('indexed', 'local', NULL, '2026-11-23'),
      ('deferred', 'local', NULL, '2026-11-23'),
      ('archived', 'local', '2026-11-23', '2026-11-23'),
      ('remote', 'remote', NULL, '2026-11-23');
  `);
});

afterEach(() => {
  stopSessionIndexBackfill();
  test.fixture?.close();
  test.fixture = undefined;
});

it('fills due local unarchived sessions in recency order and schedules a restored session', async () => {
  const logger = { info: vi.fn(), error: vi.fn() };
  await indexSessionsInBackground(logger);

  expect(test.backfill.mock.calls).toEqual([['newer', true], ['older', true]]);
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ total: 2, done: 2 }), 'Session index built');

  test.fixture!.sqlite.prepare("UPDATE sessions SET archived_at = NULL WHERE id = 'archived'").run();
  sessionEvents._emit('session:created', { id: 'archived' } as Session);
  await vi.waitFor(() => expect(test.backfill).toHaveBeenLastCalledWith('archived', false));
});
