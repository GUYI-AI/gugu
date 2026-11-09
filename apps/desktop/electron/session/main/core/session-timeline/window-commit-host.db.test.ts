import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import { EventStreamSource } from '@gugu/session-wire';
import { connect, memoryTransportPair, defineContract, type Connection } from '@gugu/session-wire/api';
import { createEventStreamHost } from '@gugu/session-wire';
import { createTestWire } from '@gugu/session-wire/testing';
import { acpRuntimeApiContract } from '@gugu/session-core/acp';
import { bindWindowCommitProjection, connectWindowCommitHost, reserveWindowCommitHost } from './window-commit-host';
import { createWindowCommitReceipts } from './window-commit-receipt';
import { readWindowCommitSourceChunk } from './window-commit-source';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowCommittedEvent } from './window-commit-tap';
import { events as hostEvents } from '@main/lib/events';
import { reserveWindowCommitHost as reserveProduction } from './window-commit-production';
import { readPublishedCommitEntity } from './window-commit-publisher';
import * as publishers from './window-commit-publisher';
import { openCommitBodySlot, readCommitBodySlot } from './window-commit-slot';
import { withStoredTurns } from '../sessions/session-turn-store';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined, root: '' }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));

describe('the main-process commit host and actual canonical writer', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, connected: Awaited<ReturnType<typeof connectWindowCommitHost>> | undefined;
  let pair: ReturnType<typeof memoryTransportPair>, connection: Connection;
  const source = () => new EventStreamSource<WindowCommittedEvent>({ generation: 21 });
  const stream = (events: ReturnType<typeof source>) => ({ snapshot: async () => events.snapshot(), attach: async (push: Parameters<typeof events.subscribe>[0]) => events.subscribe(push) });
  beforeEach(async () => {
    pair = memoryTransportPair(); connection = connect(pair.left);
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    state.root = await mkdtemp(join(tmpdir(), 'commit-host-'));
  });
  afterEach(async () => {
    // Close the test source even when a test only reserved a cold host.
    connected ??= await connectWindowCommitHost(stream(source()), () => {}, connection); connected.close(); connected = undefined; pair.disconnect();
    fixture?.close(); state.db = undefined; state.sqlite = undefined; await rm(state.root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.clearAllMocks();
  });

  it('registers before worker availability, persists one real event and withholds delivery until projection completion', async () => {
    const events = source(), observed = vi.fn(), failed = vi.fn(), durable = Promise.withResolvers<void>();
    const projection = Promise.withResolvers<{ projectionId: string }>();
    bindWindowCommitProjection(async receipt => {
      expect(createWindowCommitReceipts(fixture.sqlite).byRow(receipt.rowId)?.sourceId).toBe(receipt.sourceId);
      const raw = await readWindowCommitSourceChunk(join(state.root, 'session-window-cache', 'committed'), receipt.binding, receipt.source, 0, createWindowBudget());
      expect(new TextDecoder().decode(raw)).toContain('whole cold turn'); durable.resolve(); return projection.promise;
    });
    const owner = reserveWindowCommitHost('view', 'c', failed), after = await owner.prepare(); owner.authorize();
    expect(events.subscriberCount).toBe(0); expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toEqual([]);
    connected = await connectWindowCommitHost(stream(events), observed, connection);
    const actual: WindowCommittedEvent = { sessionId: 'c', providerId: 'claude', platformCredentials: false, source: 'live', turn: {
      id: 'actual-turn', seq: 0, referenceId: 'actual-ref', initiator: 'user', outcome: { kind: 'done' },
      items: [{ kind: 'message', id: 'actual-item', seq: 0, role: 'assistant', text: 'whole cold turn' }],
    } };
    const received = vi.fn(), reading = owner.read(after).then(received); events.emit(actual); await durable.promise;
    expect(observed).toHaveBeenCalledExactlyOnceWith(actual); expect(received).not.toHaveBeenCalled();
    projection.resolve({ projectionId: 'deferred-producer-test' }); await reading;
    expect(received.mock.calls[0][0].entries[0]).toMatchObject({ rowId: 'c:0', storedSeq: 0, referenceId: 'actual-ref' });
    owner.ack(received.mock.calls[0][0].next); expect(failed).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 });
  });

  it('writes no commit source, catalog or intent for a production canonical write while no window subscribes', async () => {
    const events = source(), project = vi.fn(async () => ({ projectionId: 'unused' }));
    bindWindowCommitProjection(project);
    connected = await connectWindowCommitHost(stream(events), () => {}, connection);
    events.emit({ sessionId: 'c', providerId: 'claude', platformCredentials: false, source: 'live', turn: {
      id: 'unwatched', seq: 0, referenceId: 'unwatched-ref', initiator: 'user', outcome: { kind: 'done' },
      items: [{ kind: 'message', id: 'unwatched-item', seq: 0, role: 'assistant', text: 'no window is open' }] } });
    await vi.waitFor(() => expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 }));
    await withStoredTurns('c', async () => {});
    // Until host GC reclaims them, sources exist only for a subscribed window.
    expect(await readdir(join(state.root, 'session-window-cache', 'committed'))).toEqual([]);
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_commit_receipts').get()).toEqual({ n: 0 });
    expect(project).not.toHaveBeenCalled();
  });

  it('attaches the committed-event source only after storage preparation, and refuses windows if it fails', async () => {
    const events = source(), project = vi.fn(async () => ({ projectionId: 'unused' })), gate = Promise.withResolvers<void>();
    gate.promise.catch(() => {}); // Handled by connect; avoid an early unhandled-rejection report.
    bindWindowCommitProjection(project);
    const connecting = connectWindowCommitHost(stream(events), () => {}, connection, () => gate.promise);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(events.subscriberCount).toBe(0);
    gate.reject(new Error('layout could not be prepared')); connected = await connecting;
    expect(events.subscriberCount).toBe(1);
    expect(() => reserveWindowCommitHost('view', 'c', vi.fn())).toThrow(expect.objectContaining({ code: 'live_projection_unavailable' }));
    events.emit({ sessionId: 'c', providerId: 'claude', platformCredentials: false, source: 'live', turn: {
      id: 'kept', seq: 0, referenceId: 'kept-ref', initiator: 'user', outcome: { kind: 'done' },
      items: [{ kind: 'message', id: 'kept-item', seq: 0, role: 'assistant', text: 'canonical history still persists' }] } });
    await vi.waitFor(() => expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 }));
    expect(project).not.toHaveBeenCalled();
  });

  it('rejects new handoff reservations without a durable producer rather than declaring a successful empty view', () => {
    expect(() => reserveWindowCommitHost('view', 'c', vi.fn())).toThrow(expect.objectContaining({ code: 'live_projection_unavailable' }));
    expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toEqual([]);
  });

  it('commits the next canonical row while projection is held, but publishes projections in order', async () => {
    const actual = source(), gate = Promise.withResolvers<{ projectionId: string }>(), entered = Promise.withResolvers<void>();
    const project = vi.fn(async (receipt: { referenceId: string }) => {
      if (receipt.referenceId === 'one') { entered.resolve(); return gate.promise; }
      return { projectionId: 'projection-two' };
    });
    bindWindowCommitProjection(project);
    const failed = vi.fn(), owner = reserveWindowCommitHost('view', 'c', failed), after = await owner.prepare(); owner.authorize();
    connected = await connectWindowCommitHost(stream(actual), () => {}, connection);
    const seen = vi.fn(), reading = owner.read(after).then(page => { seen(page); return page; });
    const emit = (referenceId: string) => actual.emit({ sessionId: 'c', source: 'live', turn: {
      id: referenceId, seq: 0, referenceId, initiator: 'user', items: [], outcome: { kind: 'done' },
    } });
    try {
      emit('one'); await entered.promise; emit('two');
      await vi.waitFor(() => expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 2 }));
      expect(await withStoredTurns('c', async () => createWindowCommitReceipts(fixture.sqlite).byReference('c', 'two')?.storedSeq)).toBe(1);
      expect(project).toHaveBeenCalledTimes(2); expect(seen).not.toHaveBeenCalled();
    } finally { gate.resolve({ projectionId: 'projection-one' }); await withStoredTurns('c', async () => {}); }
    const first = await reading; expect(first.entries[0].referenceId).toBe('one'); owner.ack(first.next);
    const second = await owner.read(first.next); expect(second.entries[0].referenceId).toBe('two'); owner.ack(second.next);
    expect(project).toHaveBeenCalledTimes(2); expect(failed).not.toHaveBeenCalled(); owner.close();
  });

  it('fails instead of handing out a real publication whose receipt was deleted after the publisher returned', async () => {
    const create = publishers.createWindowCommitPublisher;
    vi.spyOn(publishers, 'createWindowCommitPublisher').mockImplementation((...args) => {
      const publisher = create(...args);
      return { async publish(...input) {
        const result = await publisher.publish(...input);
        queueMicrotask(() => fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(input[0].rowId));
        return result;
      } };
    });
    const actual = source(), failed = vi.fn(), owner = reserveProduction('view', 'c', failed), after = await owner.prepare(); owner.authorize();
    connected = await connectWindowCommitHost(stream(actual), () => {}, connection);
    const reading = expect(owner.read(after)).rejects.toMatchObject({ code: 'live_commit_failed' });
    actual.emit({ sessionId: 'c', source: 'live', turn: { id: 'deleted', seq: 0, referenceId: 'deleted-ref', initiator: 'user',
      items: [{ kind: 'message', id: 'm', seq: 0, role: 'assistant', text: 'real durable projection' }], outcome: { kind: 'done' } } });
    await reading; expect(failed).toHaveBeenCalledTimes(1);
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 0 });
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_window_commit_receipts').get()).toEqual({ n: 0 });
  });

  it('delivers a cold complete turn through the real durable publisher, journal, body point read and ACK', async () => {
    const failed = vi.fn(), events = source(), owner = reserveProduction('real-view', 'c', failed), after = await owner.prepare();
    expect(events.subscriberCount).toBe(0); expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toEqual([]);
    connected = await connectWindowCommitHost(stream(events), () => {}, connection);
    const written = Promise.withResolvers<void>();
    vi.mocked(hostEvents.emit).mockImplementation(channel => { if (channel.name === 'session:turn-settled') written.resolve(); });
    events.emit({ sessionId: 'c', source: 'live', turn: { id: 'gap-turn', seq: 0, referenceId: 'gap-ref', initiator: 'user',
      items: [{ kind: 'message', id: 'gap-item', seq: 0, role: 'assistant', text: 'complete before live attaches' }], outcome: { kind: 'done' } } });
    await written.promise; owner.authorize(); const page = await owner.read(after);
    expect(page.entries).toHaveLength(1); expect(page.entries[0]).toMatchObject({ kind: 'insert', referenceId: 'gap-ref', storedSeq: 0 });
    const receipts = createWindowCommitReceipts(fixture.sqlite), receipt = receipts.byReference('c', 'gap-ref')!;
    const directory = join(state.root, 'session-window-cache', 'committed');
    const entity = await readPublishedCommitEntity({ directory, receipts, receipt }, page.entries[0].projectionId, 0, createWindowBudget());
    const body = openCommitBodySlot(directory, receipts, receipt, entity.facts, 'text', entity.bodyBuildId);
    expect(await readCommitBodySlot(body, 0, createWindowBudget())).toMatchObject({ kind: 'body', text: 'complete before live attaches', moreAfter: 'no' });
    owner.ack(page.next); const waiting = expect(owner.read(page.next)).rejects.toMatchObject({ code: 'unsubscribed' });
    owner.close(); await waiting; expect(failed).not.toHaveBeenCalled();
  });

  it('awaits source attachment before releasing the worker boundary and fails a cold owner on setup failure', async () => {
    bindWindowCommitProjection(async () => ({ projectionId: 'unused' }));
    const failed = vi.fn(), owner = reserveWindowCommitHost('view', 'c', failed); await owner.prepare();
    const attachment = Promise.withResolvers<() => void>(), entered = Promise.withResolvers<void>(), returned = vi.fn();
    const connecting = connectWindowCommitHost({ snapshot: async () => source().snapshot(), attach: () => { entered.resolve(); return attachment.promise; } }, () => {}, connection).then(returned);
    await entered.promise; expect(returned).not.toHaveBeenCalled();
    attachment.reject(new Error('private attach failed')); await expect(connecting).rejects.toThrow('private attach failed');
    expect(failed).toHaveBeenCalledTimes(1); owner.close();
  });

  it('fails bounded owners when cache initialization fails while keeping ordinary canonical writes available', async () => {
    await writeFile(join(state.root, 'session-window-cache'), 'not a directory');
    bindWindowCommitProjection(async () => ({ projectionId: 'unused' }));
    const failed = vi.fn(), owner = reserveWindowCommitHost('view', 'c', failed), after = await owner.prepare(); owner.authorize();
    const rejected = expect(owner.read(after)).rejects.toMatchObject({ code: 'live_store_changed' });
    const actual = source(); connected = await connectWindowCommitHost(stream(actual), () => {}, connection); await rejected;
    expect(failed).toHaveBeenCalledTimes(1);
    expect(() => reserveWindowCommitHost('next', 'c', vi.fn())).toThrow(expect.objectContaining({ code: 'live_projection_unavailable' }));
    const settled = Promise.withResolvers<void>();
    vi.mocked(hostEvents.emit).mockImplementation(channel => { if (channel.name === 'session:turn-settled') settled.resolve(); });
    actual.emit({ sessionId: 'c', source: 'live', turn: { id: 'real', seq: 0, referenceId: 'actual-ref', initiator: 'user', items: [], outcome: { kind: 'done' } } });
    await settled.promise;
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 1 });
    expect(fixture.sqlite.prepare('SELECT source_id FROM session_window_commit_receipts').all()).toEqual([]);
  });

  it('reports worker disappearance once while explicit view cancellation remains silent', async () => {
    bindWindowCommitProjection(async () => ({ projectionId: 'unused' }));
    const failed = vi.fn(), cancelled = vi.fn(), a = reserveWindowCommitHost('one', 'c', failed), b = reserveWindowCommitHost('two', 'c', cancelled);
    const after = await a.prepare(); await b.prepare(); a.authorize(); b.close();
    connected = await connectWindowCommitHost(stream(source()), () => {}, connection);
    const rejected = expect(a.read(after)).rejects.toMatchObject({ code: 'live_source_gap' });
    connected.close(); await rejected;
    expect(failed).toHaveBeenCalledTimes(1); expect(cancelled).not.toHaveBeenCalled();
  });

  it('settles a waiting owner on real wire disconnection without manual close or a restart', async () => {
    const contract = defineContract({ turnCommitted: acpRuntimeApiContract.turnCommitted }), events = createEventStreamHost(contract.turnCommitted);
    const wire = createTestWire(contract, { turnCommitted: events });
    try {
      bindWindowCommitProjection(async () => ({ projectionId: 'unused' }));
      const failed = vi.fn(), owner = reserveWindowCommitHost('view', 'c', failed), after = await owner.prepare(); owner.authorize();
      connected = await connectWindowCommitHost(wire.client.turnCommitted.handle(undefined), () => {}, wire.connection);
      const rejected = expect(owner.read(after)).rejects.toMatchObject({ code: 'live_source_gap' }); wire.pair.disconnect(); await rejected;
      expect(failed).toHaveBeenCalledTimes(1);
    } finally { wire.dispose(); }
  });

  it('allows producer rebinding without retargeting an in-flight commit or letting an old disposer stop the new owner', async () => {
    const projectA = vi.fn(async () => ({ projectionId: 'producer-A' })), projectB = vi.fn(async () => ({ projectionId: 'producer-B' }));
    const releaseA = bindWindowCommitProjection(projectA), failedA = vi.fn(), failedB = vi.fn();
    const a = reserveWindowCommitHost('one', 'c', failedA), cut = await a.prepare(); a.authorize();
    const actual = source(); connected = await connectWindowCommitHost(stream(actual), () => {}, connection);
    const oldRead = expect(a.read(cut)).rejects.toMatchObject({ code: 'live_store_changed' });
    const emit = (referenceId: string) => actual.emit({ sessionId: 'c', source: 'live', turn: {
      id: referenceId, seq: 0, referenceId, initiator: 'user', items: [], outcome: { kind: 'done' },
    } });
    emit('reference-A'); releaseA(); await oldRead;
    bindWindowCommitProjection(projectB);
    const b = reserveWindowCommitHost('two', 'c', failedB), after = await b.prepare(); b.authorize();
    releaseA(); emit('reference-B');
    const page = await b.read(after);
    expect(page.entries.map(item => [item.referenceId, item.projectionId])).toEqual([['reference-B', 'producer-B']]);
    expect(projectA).toHaveBeenCalledTimes(1); expect(projectB).toHaveBeenCalledTimes(1);
    expect(failedA).toHaveBeenCalledTimes(1); expect(failedB).not.toHaveBeenCalled();
  });
});
