import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { createWindowCommitReceipts } from './window-commit-receipt';
import { createWindowPackPublisher } from './window-pack-publisher';
import { createWindowProjectionHost } from './window-projection-host';
import { WINDOW_COMMIT_LAYOUT_MARKER } from './window-commit-layout';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('host reclamation of commit sources, catalogs and packs', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, root: string, directory: string;
  let host: ReturnType<typeof createWindowProjectionHost> | undefined, publisher: ReturnType<typeof createWindowPackPublisher> | undefined;
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p'), ('kept','p')");
    root = await mkdtemp(join(tmpdir(), 'commit-reclaim-')); directory = join(root, 'committed'); await mkdir(directory);
    host = createWindowProjectionHost({ connection: fixture.sqlite, directory, lockDirectory: join(root, 'guards'), report: () => {} });
    await host.prepared;
    publisher = createWindowPackPublisher(directory, fixture.sqlite);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await publisher?.close(); await host?.shutdown(); host = undefined; publisher = undefined;
    fixture?.close(); state.db = undefined; state.sqlite = undefined; await rm(root, { recursive: true, force: true });
  });
  async function committed(sessionId: string, scope: string) {
    await persistCommittedTurn({ sessionId, source: 'live', turn: { id: `${sessionId}-t`, seq: 0, referenceId: `${sessionId}-ref`, initiator: 'user', outcome: { kind: 'done' },
      items: [{ kind: 'message', id: `${sessionId}-m`, seq: 0, role: 'assistant', text: `body of ${sessionId}` }] },
      windowCapture: { directory, scope, cursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 1 }, committed: async () => {} } });
    const receipt = createWindowCommitReceipts(fixture.sqlite).byReference(sessionId, `${sessionId}-ref`)!;
    await publisher!.project(receipt, true); return receipt;
  }
  const files = async () => (await readdir(directory, { recursive: true })).map(String).sort();
  const packs = async () => (await readdir(directory)).filter(name => name.endsWith('.pack'));
  async function collected() { for (let pass = 0; pass < 8; pass++) await host!.collect(); }

  it('removes the deleted session’s raw source, catalog and pack files, keeping another session’s', async () => {
    const gone = await committed('c', 'a'.repeat(64)), kept = await committed('kept', 'b'.repeat(64));
    const before = await files(), packsBefore = await packs();
    expect(before.filter(name => name.endsWith('.source'))).toHaveLength(2);
    expect(before).toEqual(expect.arrayContaining([join('source-versions', gone.binding.scope, `${gone.sourceId}.version`),
      join('source-versions', kept.binding.scope, `${kept.sourceId}.version`)]));
    expect(packsBefore).toHaveLength(2);

    fixture.sqlite.prepare('DELETE FROM sessions WHERE id=?').run('c');
    await collected();

    const after = await files();
    expect(after.filter(name => name.endsWith('.source'))).toHaveLength(1);
    expect(after).not.toContain(join('source-versions', gone.binding.scope, `${gone.sourceId}.version`));
    expect(after).toContain(join('source-versions', kept.binding.scope, `${kept.sourceId}.version`));
    // Deleting the session cascades its pack group rows at once; the file sweep reclaims the pack itself.
    expect(await packs()).toEqual(packsBefore.filter(name => fixture.sqlite.prepare('SELECT 1 FROM session_window_pack_groups WHERE group_id=?').get(name.slice(0, 32))));
    expect(await packs()).toHaveLength(1);
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_pack_groups').get()).toEqual({ n: 1 });
    expect(createWindowCommitReceipts(fixture.sqlite).bySource(kept.sourceId)).toEqual(kept);
    expect(after).toContain(WINDOW_COMMIT_LAYOUT_MARKER);
  });

  it('keeps a current version, its source and its pack across collection passes', async () => {
    const kept = await committed('kept', 'b'.repeat(64)), before = await files();
    await collected();
    expect(await files()).toEqual(before);
    expect(createWindowCommitReceipts(fixture.sqlite).bySource(kept.sourceId)).toEqual(kept);
  });
});
