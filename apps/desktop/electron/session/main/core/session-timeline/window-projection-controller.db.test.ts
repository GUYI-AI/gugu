import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { openFixture } from '@tooling/utils/db';
import { windowProjectionReadResultSchema, windowProjectionBodyReadResultSchema } from '@gugu/session-wire/session-window-projection';

const state = vi.hoisted(() => ({ directory: '', db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined,
  owners: new Map<string, { sessionId: string; alive: boolean; ready: boolean; abort: AbortController }>(),
  host: undefined as ReturnType<typeof import('./window-projection-host').createWindowProjectionHost> | undefined,
  afterRun: undefined as (() => void | Promise<void>) | undefined,
  afterReply: undefined as ((result: unknown) => void | Promise<void>) | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; }, sessionDatabaseConnection: () => state.sqlite }));
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
function projectionMocks() {
  vi.doMock('./window-projection-host', async original => {
    const actual = await original<typeof import('./window-projection-host')>();
    return { ...actual, createWindowProjectionHost(input: Parameters<typeof actual.createWindowProjectionHost>[0]) {
      const host = actual.createWindowProjectionHost({ ...input, lockDirectory: join(state.directory, 'guards') });
      state.host = host;
      return { ...host, async run<T>(...args: Parameters<typeof host.run<T>>) {
        const value = await host.run<T>(...args); const after = state.afterRun; state.afterRun = undefined; await after?.(); return value;
      } };
    } };
  });
  vi.doMock('./window-projection-production', async original => {
    const actual = await original<typeof import('./window-projection-production')>();
    async function returned<T>(pending: Promise<T>) {
      const result = await pending, after = state.afterReply; state.afterReply = undefined; await after?.(result); return result;
    }
    return { ...actual,
      readWindowProjection: (...args: Parameters<typeof actual.readWindowProjection>) => returned(actual.readWindowProjection(...args)),
      readWindowProjectionBody: (...args: Parameters<typeof actual.readWindowProjectionBody>) => returned(actual.readWindowProjectionBody(...args)),
    };
  });
}
vi.mock('./create-session', () => ({}));
vi.mock('./turn-files', () => ({ prefetchFiles: vi.fn() }));
vi.mock('./task-exchanges', () => ({ readTaskExchanges: vi.fn(), watchTaskExchanges: vi.fn(), unwatchTaskExchanges: vi.fn() }));
vi.mock('./service', () => ({
  nativeRecord: vi.fn(), nativeToolImage: vi.fn(), nativeAttachment: vi.fn(),
  windowPrepare: async (input: { conversationId: string; subscriptionId: string }) => {
    state.owners.set(input.subscriptionId, { sessionId: input.conversationId, alive: true, ready: false, abort: new AbortController() });
    return { ok: true, value: { source: 'window' } };
  },
  windowSubscribe: async (input: { subscriptionId: string }) => { state.owners.get(input.subscriptionId)!.ready = true;
    return { ok: true, value: { subscriptionId: input.subscriptionId } }; },
  windowProjectionOwner(input: { conversationId: string; subscriptionId: string }) {
    const owner = state.owners.get(input.subscriptionId);
    return { identity: owner!, sessionId: input.conversationId, signal: owner?.abort.signal, assertCurrent() {
      if (!owner?.alive || !owner.ready || owner.sessionId !== input.conversationId || state.owners.get(input.subscriptionId) !== owner)
        throw Object.assign(new Error('closed'), { code: 'unsubscribed' });
    } };
  },
  windowLiveAck: async () => ({ ok: true, value: undefined }),
  unsubscribe(id: string) { const owner = state.owners.get(id); if (!owner) return; owner.alive = false; owner.abort.abort();
    void state.host?.close(owner).catch(() => {}); },
}));

describe('registered projection RPC with real source, publication, handles and pins', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, release: (sender: number) => void;
  let call: (sender: number, method: string, input: unknown) => Promise<unknown>;
  let position: import('@gugu/session-wire/session-window-live').WindowLivePosition;
  const owner = { conversationId: 'c', subscriptionId: 'projection-window' };
  beforeEach(async () => {
    vi.resetModules(); projectionMocks(); state.owners.clear(); state.host = undefined; state.afterRun = undefined; state.afterReply = undefined;
    state.directory = await mkdtemp(join(tmpdir(), 'projection-rpc-'));
    fixture = await (await import('@tooling/utils/db')).openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    const directory = join(state.directory, 'session-window-cache', 'committed'); await mkdir(directory, { recursive: true });
    const { persistCommittedTurn } = await import('../sessions/session-turn-store');
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: { id: 't', referenceId: 'real', seq: 0, initiator: 'agent',
      items: [{ kind: 'message', id: 'm', seq: 0, role: 'assistant', text: 'actual RPC 正文' }] }, windowCapture: { directory,
      scope: createHash('sha256').update(JSON.stringify([directory, 'c'])).digest('hex'),
      cursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 1 }, committed: async () => {} } });
    const { createWindowCommitReceipts } = await import('./window-commit-receipt');
    const { createWindowCommitPublisher } = await import('./window-commit-publisher');
    const receipts = createWindowCommitReceipts(fixture.sqlite), receipt = receipts.byReference('c', 'real')!;
    const version = await createWindowCommitPublisher(directory, receipts).publish(receipt);
    position = { rowId: receipt.rowId, storedSeq: receipt.storedSeq, referenceId: receipt.referenceId, projectionId: version.projectionId };
    const { sessionTimelineController, releaseSubscriptionsOf } = await import('./controller'); release = releaseSubscriptionsOf;
    const { registerRPCRouter } = await import('@shared/lib/ipc/rpc');
    const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>();
    registerRPCRouter({ sessionTimeline: sessionTimelineController }, { handle: (channel, handler) => handlers.set(channel, handler) });
    call = async (sender, method, input) => handlers.get(`sessionTimeline.${method}`)!({ sender: { id: sender } }, input);
    await call(920, 'sessionWindowPrepare', owner); await call(920, 'sessionWindowSubscribe', owner);
  });
  afterEach(async () => { release?.(920); release?.(921); await state.host?.shutdown(); vi.restoreAllMocks();
    fixture?.close(); state.db = undefined; state.sqlite = undefined; await rm(state.directory, { recursive: true, force: true }); });
  async function body() {
    const opened = windowProjectionReadResultSchema.parse(await call(920, 'sessionWindowProjectionRead', { ...owner, kind: 'open', position }));
    if (!opened.ok || !opened.value || !('root' in opened.value)) throw new Error('missing actual open');
    const page = windowProjectionReadResultSchema.parse(await call(920, 'sessionWindowProjectionRead', { ...owner, kind: 'page', cursor: opened.value.next }));
    if (!page.ok || !page.value || !('bodies' in page.value)) throw new Error('missing actual page');
    return { lease: opened.value.lease, handle: page.value.bodies[0].handle, cursor: opened.value.next! };
  }
  it('binds both real routes to sender, rejects extra fields and retains a resident body after ACK', async () => {
    await expect(call(921, 'sessionWindowProjectionRead', { ...owner, kind: 'open', position })).resolves.toMatchObject({ ok: false });
    await expect(call(920, 'sessionWindowProjectionRead', { ...owner, kind: 'open', position, range: {} })).resolves.toMatchObject({ ok: false });
    const opened = await body();
    await call(920, 'sessionWindowLiveAck', { ...owner, through: { workerEpoch: 'w', storeEpoch: 's', sequence: 1 } });
    expect(windowProjectionBodyReadResultSchema.parse(await call(920, 'sessionWindowProjectionBodyRead', { ...owner, handle: opened.handle })))
      .toMatchObject({ ok: true, value: { kind: 'body', text: 'actual RPC 正文', offset: 0, next: null } });
    await call(920, 'sessionWindowProjectionRead', { ...owner, kind: 'release', lease: opened.lease });
    await expect(call(920, 'sessionWindowProjectionBodyRead', { ...owner, handle: opened.handle })).resolves.toMatchObject({ ok: false });
  });
  it('rechecks the real receipt after the host async return gap at the public export', async () => {
    const opened = await body(); state.afterRun = () => { fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(position.rowId); };
    await expect(call(920, 'sessionWindowProjectionBodyRead', { ...owner, handle: opened.handle }))
      .resolves.toMatchObject({ ok: false, error: { code: 'needs_location' } });
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM session_window_commit_receipts').get()).toEqual({ count: 0 });
  });
  it('revokes a disconnected connection before its completed body reply is delivered', async () => {
    const opened = await body();
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    state.afterRun = async () => { entered.resolve(); await gate.promise; };
    const reading = call(920, 'sessionWindowProjectionBodyRead', { ...owner, handle: opened.handle });
    await entered.promise; release(920); gate.resolve();
    await expect(reading).resolves.toMatchObject({ ok: false });
    await expect(call(921, 'sessionWindowProjectionBodyRead', { ...owner, handle: opened.handle })).resolves.toMatchObject({ ok: false });
  });
  it('rejects physical source deletion after the host helper returns and before the public reply', async () => {
    const opened = await body(), { createWindowCommitReceipts } = await import('./window-commit-receipt');
    const { windowCommitSourcePath } = await import('./window-commit-source');
    const receipt = createWindowCommitReceipts(fixture.sqlite).bySource(position.projectionId.split('/')[0])!;
    state.afterRun = () => { rmSync(windowCommitSourcePath(join(state.directory, 'session-window-cache', 'committed'), receipt.binding)); };
    await expect(call(920, 'sessionWindowProjectionBodyRead', { ...owner, handle: opened.handle }))
      .resolves.toMatchObject({ ok: false, error: { code: 'needs_location' } });
  });
  it.each(['open', 'page', 'body'] as const)('rejects %s after a real helper success followed by canonical DELETE before the controller continuation', async kind => {
    const opened = kind === 'open' ? undefined : await body();
    state.afterReply = result => { expect(result).toMatchObject({ ok: true });
      fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(position.rowId); };
    const method = kind === 'body' ? 'sessionWindowProjectionBodyRead' : 'sessionWindowProjectionRead';
    const request = kind === 'open' ? { kind, position } : kind === 'page' ? { kind, cursor: opened!.cursor } : { handle: opened!.handle };
    await expect(call(920, method, { ...owner, ...request })).resolves.toMatchObject({ ok: false, error: { code: 'needs_location' } });
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM session_window_commit_receipts').get()).toEqual({ count: 0 });
  });
  it('rejects a completed body after release of its real lease in the controller return gap', async () => {
    const opened = await body();
    state.afterReply = async result => { expect(result).toMatchObject({ ok: true });
      await expect(call(920, 'sessionWindowProjectionRead', { ...owner, kind: 'release', lease: opened.lease })).resolves.toMatchObject({ ok: true }); };
    await expect(call(920, 'sessionWindowProjectionBodyRead', { ...owner, handle: opened.handle }))
      .resolves.toMatchObject({ ok: false, error: { code: 'closed' } });
  });
  it('rejects a completed body after physical source deletion in the controller return gap', async () => {
    const opened = await body(), { createWindowCommitReceipts } = await import('./window-commit-receipt');
    const { windowCommitSourcePath } = await import('./window-commit-source');
    const receipt = createWindowCommitReceipts(fixture.sqlite).bySource(position.projectionId.split('/')[0])!;
    state.afterReply = result => { expect(result).toMatchObject({ ok: true });
      rmSync(windowCommitSourcePath(join(state.directory, 'session-window-cache', 'committed'), receipt.binding)); };
    await expect(call(920, 'sessionWindowProjectionBodyRead', { ...owner, handle: opened.handle }))
      .resolves.toMatchObject({ ok: false, error: { code: 'needs_location' } });
  });

});
