import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() {
  if (!mocks.db) throw new Error('Test database not initialized');
  return mocks.db;
} }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

import { getStoredHistory } from './session-turn-store';
import * as notifications from './owner-notification-state';
import * as publication from './native-publication-host';

describe('stored history generation reads', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  function replace(text: string, startedAt = 1_000) {
    const turn: TranscriptTurn = { id: 'origin', seq: 0, initiator: 'user', startedAt, endedAt: startedAt + 1, outcome: { kind: 'done' },
      items: [{ id: 'origin:m', seq: 0, kind: 'message', role: 'assistant', text }] };
    fixture.sqlite.prepare('INSERT OR REPLACE INTO session_turns (id, session_id, seq, turn_id, data) VALUES (?, ?, ?, ?, ?)')
      .run('c1:0', 'c1', 0, turn.id, JSON.stringify(turn));
  }

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec("INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo'); INSERT INTO sessions (id, project_id) VALUES ('c1', 'p1');");
    replace('original');
  });
  afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

  it.each([{}, { before: 1 }, { fromSeq: 0 }])('keeps unchanged page and catch-up reads intact: %j', async params => {
    const page = await getStoredHistory({ sessionId: 'c1', ...params });
    expect(page).toMatchObject({ nativeOwnerNotificationEpoch: 0, turns: [{ items: [{ text: 'original' }] }], originTurnIds: ['origin'] });
  });

  it('discards rows read before a rewind and returns the replacement generation', async () => {
    const readEpoch = notifications.ownerNotificationEpoch;
    let checks = 0;
    vi.spyOn(notifications, 'ownerNotificationEpoch').mockImplementation(id => {
      if (++checks === 2) {
        replace('replacement');
        notifications.rewindOwnerNotificationState(id, fixture.db);
      }
      return readEpoch(id);
    });
    expect(await getStoredHistory({ sessionId: 'c1' })).toMatchObject({
      nativeOwnerNotificationEpoch: 1, turns: [{ items: [{ text: 'replacement' }] }],
    });
  });

  it('can still complete when the third generation read stabilizes', async () => {
    const readEpoch = notifications.ownerNotificationEpoch;
    let checks = 0;
    vi.spyOn(notifications, 'ownerNotificationEpoch').mockImplementation(id => {
      if (++checks === 2 || checks === 4) {
        replace(`replacement-${checks}`);
        notifications.rewindOwnerNotificationState(id, fixture.db);
      }
      return readEpoch(id);
    });
    expect(await getStoredHistory({ sessionId: 'c1' })).toMatchObject({
      nativeOwnerNotificationEpoch: 2, turns: [{ items: [{ text: 'replacement-4' }] }],
    });
  });

  it('rejects after three unstable row reads rather than returning a stale or empty page', async () => {
    const readEpoch = notifications.ownerNotificationEpoch;
    const floor = vi.spyOn(publication, 'nativeConversationHistoryFloor');
    let checks = 0;
    vi.spyOn(notifications, 'ownerNotificationEpoch').mockImplementation(id => {
      if (++checks > 6) throw new Error('Read escaped its generation budget');
      if (checks % 2 === 0) notifications.rewindOwnerNotificationState(id, fixture.db);
      return readEpoch(id);
    });
    await expect(getStoredHistory({ sessionId: 'c1' })).rejects.toMatchObject({ code: 'history_epoch_unstable' });
    expect(checks).toBe(6);
    expect(floor).not.toHaveBeenCalled();
  });

  it('rechecks the generation after awaiting the clear boundary and retains only post-clear messages', async () => {
    const floor = '1970-01-01T00:00:03.000Z';
    vi.spyOn(publication, 'nativeConversationHistoryFloor').mockImplementationOnce(async () => {
      replace('after clear', 4_000);
      notifications.rewindOwnerNotificationState('c1', fixture.db);
      return floor;
    }).mockResolvedValue(floor);
    expect(await getStoredHistory({ sessionId: 'c1' })).toMatchObject({
      nativeOwnerNotificationEpoch: 1, turns: [{ items: [{ text: 'after clear' }] }], originTurnIds: ['origin'],
    });
  });

  it('counts rewinds during clear-boundary reads against the same three-attempt budget', async () => {
    const floor = vi.spyOn(publication, 'nativeConversationHistoryFloor').mockImplementation(async () => {
      notifications.rewindOwnerNotificationState('c1', fixture.db);
      return null;
    });
    await expect(getStoredHistory({ sessionId: 'c1' })).rejects.toMatchObject({ code: 'history_epoch_unstable' });
    expect(floor).toHaveBeenCalledTimes(3);
  });

  it('propagates clear-boundary failures without retrying or reporting an empty success', async () => {
    const failure = new Error('History owner changed');
    const floor = vi.spyOn(publication, 'nativeConversationHistoryFloor').mockRejectedValue(failure);
    await expect(getStoredHistory({ sessionId: 'c1' })).rejects.toBe(failure);
    expect(floor).toHaveBeenCalledTimes(1);
  });
});
