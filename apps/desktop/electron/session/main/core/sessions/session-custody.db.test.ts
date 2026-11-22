// The custody chain: one message id has exactly one owner at a time — the sender's outbox until the host's
// session_pending accepts it, then the host row. Real outbox (IndexedDB) + real session_pending (SQLite).
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

import { enqueuePending } from './session-pending';
import { enqueueSessionInput, retrySessionInputs, state } from '../../../../../src/lib/outbox/kinds/sessionInput';
import { openOutboxStorage } from '../../../../../src/lib/outbox/storage';
import { installSessionInputOutbox, settle, type InstalledSessionInputs } from '../../../../../../../tests/helpers/sessionInputOutbox';

describe('custody chain: sender outbox → host session_pending', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
      INSERT INTO sessions (id, project_id, workspace_id, title, runtime) VALUES ('s', 'p', 'root', 'T', 'acp');
    `);
  });
  let installed: InstalledSessionInputs | undefined;
  afterEach(() => { installed?.dispose(); installed = undefined; fixture.close(); mocks.db = undefined; });

  const hostRows = () => (fixture.sqlite.prepare("SELECT message_id FROM session_pending WHERE session_id = 's' ORDER BY seq").all() as { message_id: string }[]).map(row => row.message_id);

  it('host acceptance empties the outbox in the same step; a lost reply is retried into the same single host row', async () => {
    let loseReply = true;
    // The real outbox (IndexedDB) with the session-input kind; the transport hands the input to the real session_pending.
    installed = installSessionInputOutbox({ storage: openOutboxStorage(new IDBFactory()), send: async input => {
      enqueuePending({ sessionId: input.sessionId, messageId: input.id, text: input.text, kind: 'session-direct' });
      if (loseReply) { loseReply = false; throw new Error('reply lost on the way back'); }
    } });
    const outboxIds = () => state().rows.map(row => row.id);

    const input = await enqueueSessionInput({ deviceId: null, sessionId: 's', text: 'hello' });
    await settle();
    // The host has it, but the sender never heard back: it still holds its copy (waiting to send it again).
    expect(hostRows()).toEqual([input.id]);
    expect(outboxIds()).toEqual([input.id]);

    await retrySessionInputs(); await settle();
    expect(hostRows()).toEqual([input.id]);
    expect(outboxIds()).toEqual([]);

    const second = await enqueueSessionInput({ deviceId: null, sessionId: 's', text: 'hello' });
    await settle();
    // Same words, a new id: a second message, never merged into the first.
    expect(hostRows()).toEqual([input.id, second.id]);
    expect(outboxIds()).toEqual([]);
  });
});
