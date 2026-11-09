import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowCommitReceipts, type WindowCommitReceipt } from '../session-timeline/window-commit-receipt';
import * as writeHelpers from '../session-timeline/window-commit-write';
import { readWindowCommitSourceChunk, readWindowCommitSourceManifest } from '../session-timeline/window-commit-source';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { EventStreamSource } from '@gugu/session-wire';
import { createWindowCommitRuntime } from '../session-timeline/window-commit-runtime';
import type { WindowCommittedEvent } from '../session-timeline/window-commit-tap';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({
  get db() { if (!state.db) throw new Error('No fixture DB'); return state.db; },
  get sqlite() { if (!state.sqlite) throw new Error('Unexpected raw SQLite access'); return state.sqlite; },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { events } from '@main/lib/events';
import { persistCommittedTurn } from './session-turn-store';

const cursor = (sequence: number) => ({ workerEpoch: 'worker', storeEpoch: 'store', sequence });
const turn = (text = 'canonical 😀中文'.repeat(10000)): TranscriptTurn => ({
  id: 'runtime:0', seq: 0, referenceId: 'source:real', initiator: 'user', outcome: { kind: 'done' },
  items: [{ kind: 'message', id: 'runtime:0:item', seq: 0, role: 'assistant', text }],
});

describe('actual canonical writer capture', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, root: string;
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    root = await mkdtemp(join(tmpdir(), 'canonical-source-'));
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined; if (root) await rm(root, { recursive: true, force: true }); });
  const settled = () => vi.mocked(events.emit).mock.calls.filter(([channel]) => channel.name === 'session:turn-settled').map(([, value]) => (value as { status: string }).status);
  function capture(sequence: number, phases: string[], completed: (receipt: WindowCommitReceipt | null) => Promise<void> = async () => {}) {
    return { directory: root, scope: 'a'.repeat(64), cursor: cursor(sequence),
      phase(name: 'source_durable' | 'canonical_committed', receipt: WindowCommitReceipt) {
        phases.push(name);
        const present = createWindowCommitReceipts(fixture.sqlite).byRow(receipt.rowId);
        expect(present?.sourceId ?? null).toBe(name === 'source_durable' ? null : receipt.sourceId);
      }, committed: completed };
  }

  it('reuses one serialized canonical value, commits its receipt in the row transaction and leaves final projection publication to the owner', async () => {
    const phases: string[] = [], original = JSON.stringify; let serializations = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: unknown[]) => {
      if (value && typeof value === 'object' && 'items' in value && Array.isArray(value.items)) serializations++;
      return Reflect.apply(original, JSON, [value, ...rest]) as string;
    }) as typeof original);
    const committed = vi.fn(async (receipt: WindowCommitReceipt | null) => {
      expect(settled()).toEqual(['persisted']); expect(receipt).not.toBeNull();
      const row = fixture.sqlite.prepare('SELECT data FROM session_turns WHERE id=?').get(receipt!.rowId) as { data: string };
      expect(createHash('sha256').update(row.data).digest('hex')).toBe(receipt!.source.sha256);
      const bytes = await readWindowCommitSourceChunk(root, receipt!.binding, receipt!.source, 0, createWindowBudget());
      expect(bytes).toEqual(Buffer.from(row.data).subarray(0, bytes.length)); phases.push('owner-publication');
    });
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn(), windowCapture: capture(3, phases, committed) });
    expect(phases).toEqual(['source_durable', 'canonical_committed', 'owner-publication']);
    expect(serializations).toBe(1); expect(committed).toHaveBeenCalledTimes(1);
    expect(createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')).toMatchObject({ rowId: 'c:0', storedSeq: 0, firstCommitCursor: cursor(3) });
  });

  it('rolls the actual canonical insert back when receipt insertion fails, and never calls the publication callback', async () => {
    const phases: string[] = [], committed = vi.fn(async () => {});
    vi.spyOn(writeHelpers, 'commitWindowReceipt').mockImplementationOnce(() => { throw new Error('receipt insertion failed'); });
    await expect(persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('rollback'), windowCapture: capture(3, phases, committed) })).rejects.toThrow('receipt insertion failed');
    expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toEqual([]);
    expect(fixture.sqlite.prepare('SELECT source_id FROM session_window_commit_receipts').all()).toEqual([]);
    expect(committed).not.toHaveBeenCalled(); expect(phases).toEqual(['source_durable']); expect(settled()).toEqual(['failed']);
  });

  it('updates the same real stored row while keeping the first cursor and previous immutable source', async () => {
    const receipts: WindowCommitReceipt[] = [], completed = async (receipt: WindowCommitReceipt | null) => { if (receipt) receipts.push(receipt); };
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('first'), windowCapture: capture(3, [], completed) });
    const revisionCapture = capture(10, [], completed); delete (revisionCapture as Partial<typeof revisionCapture>).phase;
    await persistCommittedTurn({ sessionId: 'c', source: 'revision', turn: turn('revised 😀'), windowCapture: revisionCapture });
    expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toEqual([{ id: 'c:0' }]);
    const latest = createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')!;
    expect(latest.firstCommitCursor).toEqual(cursor(3)); expect(latest.latestRevisionCursor).toEqual(cursor(10));
    expect(latest.rowId).toBe(receipts[0].rowId); expect(latest.sourceId).not.toBe(receipts[0].sourceId);
    const old = await readWindowCommitSourceChunk(root, receipts[0].binding, receipts[0].source, 0, createWindowBudget());
    expect(new TextDecoder().decode(old)).toContain('first');
    expect(JSON.parse((fixture.sqlite.prepare('SELECT data FROM session_turns').get() as { data: string }).data).items[0].text).toBe('revised 😀');
  });

  it('keeps canonical settlement persisted when later projection publication fails', async () => {
    const phases: string[] = [];
    await expect(persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('kept'),
      windowCapture: capture(3, phases, async () => { throw new Error('projection failed'); }) })).rejects.toThrow('projection failed');
    expect(settled()).toEqual(['persisted']);
    expect(createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')).not.toBeNull();
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 });
  });

  it('leaves uncaptured legacy writes on the existing DB gateway without touching new receipt storage', async () => {
    state.sqlite = undefined;
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('legacy') });
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 });
    expect(fixture.sqlite.prepare('SELECT source_id FROM session_window_commit_receipts').all()).toEqual([]);
  });

  it('owns production source metadata in the canonical receipt without writing a duplicate cache manifest', async () => {
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('receipt-owned source'), windowCapture: capture(3, []) });
    const receipt = createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')!;
    expect((await readdir(root)).filter(name => !name.endsWith('.source'))).toEqual([]);
    expect(await readWindowCommitSourceManifest(root, receipt.binding, createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'not_found' });
    expect(new TextDecoder().decode(await readWindowCommitSourceChunk(root, receipt.binding, receipt.source, 0, createWindowBudget())))
      .toContain('receipt-owned source');
  });

  it('captures the event cursor before awaiting the existing canonical writer queue', async () => {
    const observer = capture(3, []);
    const pending = persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('cursor'), windowCapture: observer });
    observer.cursor.sequence = 99; await pending;
    expect(createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')!.latestRevisionCursor).toEqual(cursor(3));
  });

  it.each(['source_durable', 'canonical_committed'] as const)('keeps settlement aligned with DB facts when the %s observer throws', async phase => {
    const completed = vi.fn(async () => {}), observer = capture(3, [], completed);
    await expect(persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('observed'), windowCapture: { ...observer,
      phase(name, receipt) { observer.phase(name, receipt); if (name === phase) throw new Error('observation failed'); },
    } })).rejects.toThrow('observation failed');
    const committed = phase === 'canonical_committed';
    expect(settled()).toEqual([committed ? 'persisted' : 'failed']);
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: committed ? 1 : 0 });
    expect(createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real') !== null).toBe(committed);
    expect(completed).not.toHaveBeenCalled();
  });

  it('preserves persisted settlement for a revised row when its post-commit observer throws', async () => {
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn('before'), windowCapture: capture(3, []) });
    vi.mocked(events.emit).mockClear();
    const completed = vi.fn(async () => {});
    await expect(persistCommittedTurn({ sessionId: 'c', source: 'revision', turn: turn('after'), windowCapture: {
      ...capture(10, [], completed), phase(name) { if (name === 'canonical_committed') throw new Error('revision observer failed'); },
    } })).rejects.toThrow('revision observer failed');
    expect(settled()).toEqual(['persisted']); expect(completed).not.toHaveBeenCalled();
    expect(createWindowCommitReceipts(fixture.sqlite).byReference('c', 'source:real')!.latestRevisionCursor).toEqual(cursor(10));
    expect(JSON.parse((fixture.sqlite.prepare('SELECT data FROM session_turns').get() as { data: string }).data).items[0].text).toBe('after');
  });

  it('keeps a cold reservation through actual canonical persistence and withholds its reference until projection completion', async () => {
    const source = new EventStreamSource<WindowCommittedEvent>({ generation: 1 }), failed = vi.fn();
    const projection = Promise.withResolvers<{ projectionId: string }>(), durable = Promise.withResolvers<void>();
    let written: Promise<void> | undefined;
    const runtime = createWindowCommitRuntime({
      persist(event, windowCapture) { return written = persistCommittedTurn({ ...event, windowCapture }); },
      capture(_event, at, committed) { return { directory: root, scope: 'a'.repeat(64), cursor: at, committed }; },
      async project(receipt) {
        expect(createWindowCommitReceipts(fixture.sqlite).byRow(receipt.rowId)?.sourceId).toBe(receipt.sourceId);
        expect(settled()).toEqual(['persisted']); durable.resolve(); return projection.promise;
      }, report(error) { throw error; },
    });
    const owner = runtime.reserve('cold-view', 'c', failed), after = await owner.prepare(); owner.authorize();
    await runtime.attach({ snapshot: async () => source.snapshot(), attach: async push => source.subscribe(push) });
    const received = vi.fn(), reading = owner.read(after).then(received);
    source.emit({ sessionId: 'c', source: 'live', turn: turn('whole gap turn') }); await durable.promise;
    expect(received).not.toHaveBeenCalled(); projection.resolve({ projectionId: 'durable-test-projection' }); await written; await reading;
    const page = received.mock.calls[0][0];
    expect(page.entries[0]).toMatchObject({ rowId: 'c:0', storedSeq: 0, referenceId: 'source:real' });
    owner.ack(page.next); expect(failed).not.toHaveBeenCalled(); runtime.close();
  });
});
