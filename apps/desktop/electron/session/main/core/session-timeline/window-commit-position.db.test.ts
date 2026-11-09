import { existsSync, unlinkSync } from 'node:fs';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import { EventStreamSource } from '@gugu/session-wire';
import { connect, memoryTransportPair } from '@gugu/session-wire/api';
import { connectWindowCommitHost } from './window-commit-host';
import type { WindowCommittedEvent } from './window-commit-tap';
import * as publishers from './window-commit-publisher';
import { windowCommitProjectionDirectory } from './window-commit-projection-disk';
import * as service from './service';
import { persistCommittedTurn } from '../sessions/session-turn-store';

type Reader = ReturnType<typeof import('./desktop-source-reader').createDesktopSourceWindowReader>;
const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined, root: '', primary: vi.fn(async () => false) }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn() }, tapMainEvents: vi.fn(() => () => {}) }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../sessions/session-life', () => ({ sessionLife: () => ({ stoppedReadFence: async () => () => true }) }));
// These unrelated routes are deliberately forbidden: this test never starts a
// PTY, sends a prompt, answers permissions or queries options.
vi.mock('./write-bridge',()=>{
  const forbidden=()=>{throw new Error('Unrelated write bridge invoked by a Position query');};
  return {SessionWriteError:class extends Error{},acpSessionLive:forbidden,deliverPermissionDecision:forbidden,deliverQuestionAnswer:forbidden,
    deliverSessionCancel:forbidden,deliverSessionText:forbidden,ensureAcpSessionLive:forbidden,permissionChannelError:forbidden,prepareQuestionAnswer:forbidden};
});
vi.mock('./live-options',()=>({SessionOptionsError:class extends Error{},readSessionOptions:vi.fn(),setSessionOption:vi.fn()}));
vi.mock('./live-permissions',()=>({watchSessionState:vi.fn()}));
vi.mock('../acp/runtime-process/host', () => ({ peekAcpWorkerClient: async () => ({ windowActiveReference: state.primary }) }));
// Control only native first-frame/lifecycle ports; opening book, service, live
// lease, writer, receipts, publisher and journal remain their actual implementations.
vi.mock('./desktop-source-reader', () => ({ createDesktopSourceWindowReader: () => ({ subscribe: async (input: Parameters<Reader['subscribe']>[0], emit: Parameters<Reader['subscribe']>[1]) => {
  emit({ subscriptionId: input.subscriptionId, result: { ok: true, batch: { from: 0, cursor: { epoch: 'controlled-native-window', seq: 0 },
    turns: [], removedTurnIds: [], settlements: [], pendingLongRecords: [] } } }); return () => {};
} }) }));

let fixture: Awaited<ReturnType<typeof openFixture>>, connected: Awaited<ReturnType<typeof connectWindowCommitHost>>;
let pair: ReturnType<typeof memoryTransportPair>, source: EventStreamSource<WindowCommittedEvent>;
const input = { conversationId: 'c', subscriptionId: 'view' };
beforeEach(async () => {
  fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite; fixture.sqlite.pragma('synchronous=FULL');
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id,provider,runtime) VALUES('c','p','claude','acp')");
  state.root = await mkdtemp(join(tmpdir(), 'commit-position-')); state.primary.mockResolvedValue(false);
  pair = memoryTransportPair(); source = new EventStreamSource<WindowCommittedEvent>({ generation: 27 });
  connected = await connectWindowCommitHost({ snapshot: async () => source.snapshot(), attach: async push => source.subscribe(push) }, () => {}, connect(pair.left));
});
afterEach(async () => {
  service.unsubscribeAll(); connected?.close(); pair?.disconnect(); vi.restoreAllMocks(); vi.clearAllMocks();
  fixture?.close(); state.db = undefined; state.sqlite = undefined; await rm(state.root, { recursive: true, force: true });
});
async function open() {
  const prepared = await service.windowPrepare(input); if (!prepared.ok || prepared.value.source !== 'window') throw new Error(JSON.stringify(prepared));
  expect(await service.windowSubscribe({ ...input, cursor: null }, () => {}, () => {})).toEqual({ ok: true, value: { subscriptionId: 'view' } });
  return prepared.value.liveCursor;
}
function emit(referenceId: string, origin: WindowCommittedEvent['source'] = 'live') {
  source.emit({ sessionId: 'c', source: origin, turn: { id: referenceId, seq: 0, referenceId, initiator: 'user', outcome: { kind: 'done' },
    items: [{ kind: 'message', id: referenceId + ':item', seq: 0, role: 'assistant', text: 'actual body' }] } });
}

it('waits an admitted real projection outside the canonical tail before returning its stored position', async () => {
  const create = publishers.createWindowCommitPublisher, gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  vi.spyOn(publishers, 'createWindowCommitPublisher').mockImplementation((...args) => {
    const publisher = create(...args); return { async publish(...args) { entered.resolve(); await gate.promise; return publisher.publish(...args); } };
  });
  const after = await open(); emit('A'); await entered.promise;
  const position = service.windowLivePosition({ ...input, referenceId: 'A', appliedCursor: after });
  try { emit('B'); await vi.waitFor(() => expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 2 })); }
  finally { gate.resolve(); }
  expect(await position).toMatchObject({ ok: true, value: { kind: 'committed', position: { rowId: 'c:0', referenceId: 'A' }, firstCommitCursor: { sequence: 1 } } });
  let count = 0, cursor = after;
  while (count < 2) { const page = await service.windowLiveRead({ ...input, after: cursor }); if (!page.ok) throw new Error(JSON.stringify(page));
    count += page.value.entries.length; cursor = page.value.next; await service.windowLiveAck({ ...input, through: cursor }); }
  expect(state.primary).not.toHaveBeenCalled();
});

it('requires affirmative primary active proof and never treats a missing receipt as not_committed by itself', async () => {
  const after = await open(), request = { ...input, referenceId: 'A', appliedCursor: after };
  expect(await service.windowLivePosition(request)).toMatchObject({ ok: false, error: { code: 'needs_location' } });
  state.primary.mockResolvedValue(true);
  expect(await service.windowLivePosition(request)).toEqual({ ok: true, value: { kind: 'not_committed', sampledCursor: after } });
  expect(state.primary).toHaveBeenLastCalledWith({ sessionId: 'c', referenceId: 'A' }, { signal: expect.any(AbortSignal) });
});

it('preserves committed historical null-first proof and reports a missing publication as needs_location', async () => {
  await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: { id: 'history', seq: 0, referenceId: 'history', initiator: 'user', items: [] } });
  const after = await open(); emit('history', 'backfill');
  const page = await service.windowLiveRead({ ...input, after }); if (!page.ok) throw new Error(JSON.stringify(page));
  const request = { ...input, referenceId: 'history', appliedCursor: page.value.next };
  expect(await service.windowLivePosition(request)).toMatchObject({ ok: true, value: { kind: 'committed', firstCommitCursor: null } });
  const read = publishers.readWindowCommitPublication;
  vi.spyOn(publishers, 'readWindowCommitPublication').mockImplementation(async (...args) => {
    const key = { ...args[0].receipt.binding, kind: 'head' as const, cursor: 'publisher:job' };
    const path = join(windowCommitProjectionDirectory(join(state.root, 'session-window-cache', 'committed'), key), windowFrameName(key));
    unlinkSync(path); return read(...args);
  });
  expect(await service.windowLivePosition(request)).toMatchObject({ ok: false, error: { code: 'needs_location' } });
  expect(state.primary).not.toHaveBeenCalled();
});

it('rechecks the actual receipt after the last asynchronous descriptor read before returning a successful position', async () => {
  const after = await open(); emit('A'); const page = await service.windowLiveRead({ ...input, after }); if (!page.ok) throw new Error(JSON.stringify(page));
  const read = publishers.readWindowCommitPublication;
  vi.spyOn(publishers, 'readWindowCommitPublication').mockImplementation(async (...args) => {
    const publication = await read(...args); queueMicrotask(() => fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(args[0].receipt.rowId)); return publication;
  });
  expect(await service.windowLivePosition({ ...input, referenceId: 'A', appliedCursor: page.value.next }))
    .toMatchObject({ ok: false, error: { code: 'needs_location' } });
});

it.each(['publication', 'head', 'source'])('rechecks the independent %s after the final descriptor await', async target => {
  const after = await open(); emit('A'); const page = await service.windowLiveRead({ ...input, after });
  if (!page.ok) throw new Error(JSON.stringify(page));
  const read = publishers.readWindowCommitPublication, removed: boolean[] = [];
  vi.spyOn(publishers, 'readWindowCommitPublication').mockImplementation(async (...args) => {
    const publication = await read(...args), binding = args[0].receipt.binding;
    const key = target === 'source' ? { ...binding, kind: 'segment' as const, cursor: 'raw:data' }
      : target === 'head' ? { ...binding, kind: 'head' as const, cursor: 'publisher:job' }
      : { ...binding, kind: 'projection' as const, cursor: `publisher:${publication.buildId}:publication` };
    const committed = join(state.root, 'session-window-cache', 'committed');
    const path = target === 'source' ? join(committed, `${windowFrameName(key)}.source`)
      : join(windowCommitProjectionDirectory(committed, key), windowFrameName(key));
    removed.push(existsSync(path)); queueMicrotask(() => unlinkSync(path));
    return publication;
  });
  expect(await service.windowLivePosition({ ...input, referenceId: 'A', appliedCursor: page.value.next }))
    .toMatchObject({ ok: false, error: { code: 'needs_location' } });
  expect(removed).toEqual([true]);
});

it('returns the real committed A after an old positive probe travels across A commit and B start',async()=>{
  const after=await open(),entered=Promise.withResolvers<void>(),probe=Promise.withResolvers<boolean>();
  state.primary.mockImplementation(async()=>{entered.resolve();return probe.promise;});
  const pending=service.windowLivePosition({...input,referenceId:'A',appliedCursor:after});await entered.promise;
  emit('A');const page=await service.windowLiveRead({...input,after});if(!page.ok)throw new Error(JSON.stringify(page));
  await service.windowLiveAck({...input,through:page.value.next});emit('B');
  await vi.waitFor(()=>expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({n:2}));
  probe.resolve(true);expect(await pending).toMatchObject({ok:true,value:{kind:'committed',position:{referenceId:'A'},firstCommitCursor:{sequence:1}}});
  let cursor=page.value.next;const next=await service.windowLiveRead({...input,after:cursor});if(!next.ok)throw new Error(JSON.stringify(next));cursor=next.value.next;
  await service.windowLiveAck({...input,through:cursor});
});
