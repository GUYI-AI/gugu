import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { readWindowFrame } from '@gugu/session-core/session-record/window-cache/disk-frame';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createWindowCommitPublisher } from './window-commit-publisher';
import { createWindowCommitReceipts } from './window-commit-receipt';
import { createWindowProjectionHost } from './window-projection-host';
import * as source from './window-commit-source';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('production projection ownership with durable pins', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, directory: string, host: ReturnType<typeof createWindowProjectionHost>;
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory = await mkdtemp(join(tmpdir(), 'projection-host-'));
    host = createWindowProjectionHost({ connection: fixture.sqlite, directory, lockDirectory: join(directory, 'guards'), report: () => {} });
  });
  afterEach(async () => { vi.restoreAllMocks(); await host?.shutdown(); fixture?.close(); state.db = undefined; state.sqlite = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }); });
  async function published() {
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: { id: 't', referenceId: 'real', seq: 0, initiator: 'agent',
      items: [{ kind: 'message', id: 'm', seq: 0, role: 'assistant', text: 'actual durable body' }] },
    windowCapture: { directory, scope: 'a'.repeat(64), cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence: 1 }, committed: async () => {} } });
    const receipts = createWindowCommitReceipts(fixture.sqlite), receipt = receipts.byReference('c', 'real')!;
    const publication = await createWindowCommitPublisher(directory, receipts).publish(receipt);
    return { rowId: receipt.rowId, storedSeq: receipt.storedSeq, referenceId: receipt.referenceId, projectionId: publication.projectionId };
  }
  const budget = () => createWindowBudget();
  it('uses real durable pins and revokes only the released host owner', async () => {
    const position = await published(), owner = { identity: {}, sessionId: 'c', assertCurrent() {} };
    const opened = await host.run(owner, budget(), (adapter, id, io) => adapter.open(id, position, io));
    const row = await host.run(owner, budget(), (adapter, id, io) => adapter.readPage(id, opened.next!, io));
    const body = await host.run(owner, budget(), (adapter, id, io) => adapter.readField(id, row.bodies[0].handle, io));
    expect(body).toMatchObject({ kind: 'body', text: 'actual durable body' });
    await host.close(owner.identity);
    await expect(host.run(owner, budget(), (adapter, id, io) => adapter.readPage(id, opened.next!, io))).rejects.toMatchObject({ code: 'unsubscribed' });
    const other = { ...owner, identity: {} };
    await expect(host.run(other, budget(), (adapter, id, io) => adapter.open(id, position, io))).resolves.toMatchObject({ count: 1 });
  });
  it('waits for actual I/O settlement after revocation and refuses its late body', async () => {
    const position = await published(); let alive = true;
    const owner = { identity: {}, sessionId: 'c', assertCurrent() { if (!alive) throw Object.assign(new Error('closed'), { code: 'unsubscribed' }); } };
    const opened = await host.run(owner, budget(), (adapter, id, io) => adapter.open(id, position, io));
    const row = await host.run(owner, budget(), (adapter, id, io) => adapter.readPage(id, opened.next!, io));
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), original = source.assertWindowCommitSource;
    vi.spyOn(source, 'assertWindowCommitSource').mockImplementation(async (...args) => { await original(...args); entered.resolve(); await gate.promise; });
    const reading = host.run(owner, budget(), (adapter, id, io) => adapter.readField(id, row.bodies[0].handle, io));
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' }); await entered.promise;
    alive = false; let closed = false; const closing = host.close(owner.identity).then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); gate.resolve(); await rejected; await closing;
  });
  it('retries durable cleanup before admitting a new owner when all 32 slots were retained', async () => {
    const position = await published();
    const receipt = createWindowCommitReceipts(fixture.sqlite).bySource(position.projectionId.split('/')[0])!;
    const key = { ...receipt.binding, kind: 'head' as const, cursor: `version:pin:${receipt.sourceId}` };
    const pin = join(directory, windowFrameName(key));
    async function holders() {
      const frame = await readWindowFrame(directory, key, budget());
      if (frame.kind !== 'hit') throw new Error('missing durable pin head');
      return (JSON.parse(Buffer.from(frame.bytes).toString()) as { holders: unknown[] }).holders.length;
    }
    const owners = Array.from({ length: 32 }, () => ({ identity: {}, sessionId: 'c', assertCurrent() {} }));
    for (const owner of owners) await host.run(owner, budget(), (adapter, id, io) => adapter.open(id, position, io));
    expect(await holders()).toBe(32);
    // An actual directory in place of the pin file makes every durable release
    // fail. Keep and restore the original frame; do not substitute a fake pin.
    await rename(pin, `${pin}.saved`); await mkdir(pin);
    const closed = await Promise.allSettled(owners.map(owner => host.close(owner.identity)));
    expect(closed.every(result => result.status === 'rejected')).toBe(true);
    await rm(pin, { recursive: true }); await rename(`${pin}.saved`, pin);
    expect(await holders()).toBe(32);
    for (let i = 0; i < 32; i++) {
      const owner = { identity: {}, sessionId: 'c', assertCurrent() {} };
      await expect(host.run(owner, budget(), (adapter, id, io) => adapter.open(id, position, io))).resolves.toMatchObject({ count: 1 });
      await host.close(owner.identity);
    }
    expect(await holders()).toBe(0);
  });
  it('requires the receipt session to match the actual subscription session', async () => {
    const position = await published(), owner = { identity: {}, sessionId: 'another-session', assertCurrent() {} };
    await expect(host.run(owner, budget(), (adapter, id, io) => adapter.open(id, position, io))).rejects.toMatchObject({ code: 'unsubscribed' });
  });
});
