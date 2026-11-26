import { noopLogger } from '@gugu/session-shared/logger';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import type { ExitFact, Gen, StageName, StageOut } from '@gugu/core/local/session-life/types';
import type { LegAdapter } from './session-life-adapter';
import { SessionLife } from './session-life';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!mocks.db) throw new Error('Missing fixture'); return mocks.db; } }));
import { lifeStore } from './session-pending';

let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  fixture = await openFixture('empty'); mocks.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p','P','/repo'); INSERT INTO sessions(id,project_id,title) VALUES ('s','p','S')");
});
afterEach(() => { fixture.close(); mocks.db = undefined; });

const MCP_CLOSED = 'handshaking with MCP server failed: error sending request for url (http://127.0.0.1:61444/mcp/slot)';

/**
 * One host process over the shared SQLite fixture. A second `host()` is the process after the restart.
 * `channel` is the engine's MCP handshake (#3884): it waits on whatever `handshake` the test hands it.
 */
function host() {
  let handshake: () => Promise<void> = async () => {};
  const stages: StageName[] = [];
  const exits: ((exit: ExitFact) => void)[] = [];
  const dispatch = vi.fn<LegAdapter['dispatch']>(async () => ({ result: 'accepted', nativeReceiptId: 'native' }));
  const reportFailure = vi.fn(async (_rows: readonly unknown[], _cause: unknown) => {});
  const failed = vi.fn((_sessionId: string, _error: unknown) => {});
  const owner = new SessionLife({ logger: noopLogger, sessions: () => ['s'], store: () => lifeStore,
    adapter: () => ({ leg: 'acp', timing: 'next-tool-call',
      async run<K extends StageName>(at: K, _have: unknown, ctx: { gen: Gen }): Promise<StageOut[K]> {
        stages.push(at);
        if (at === 'channel') await handshake();
        return (at === 'identity' ? { kind: 'bound', agentUserId: 'agent' } : { at, gen: ctx.gen, timing: 'next-tool-call' }) as StageOut[K];
      }, dispatch, teardown: async () => {},
      onExit: (_have, cb) => { exits.push(cb); return () => {}; } }),
    forks: () => [], allForks: () => [], parentOf: () => null, ownedBy: async () => true,
    markRead: async () => {}, reportFailure, publish: () => {}, removed: () => {}, failed, now: Date.now });
  const startFailures = () => failed.mock.calls.map(([, error]) => String(error)).filter(text => text.includes('Start stage'));
  return { owner, stages, exits, dispatch, reportFailure, startFailures,
    handshake: (next: () => Promise<void>) => { handshake = next; },
    send: (id: string) => owner.enqueue({ sessionId: 's', messageId: id, text: id, kind: 'session-direct' }) };
}

it('control: without the quit gate an endpoint that closes mid-handshake leaves the session failed and tells its row', async () => {
  const old = host(); await old.owner.signIn('A');
  const endpoint = Promise.withResolvers<void>();
  old.handshake(() => endpoint.promise);
  const row = old.send('scheduled');
  await vi.waitFor(() => expect(old.owner.read('s').stage?.at).toBe('channel'));
  endpoint.reject(new Error(MCP_CLOSED));
  await old.owner.quiescent('s');
  expect(old.owner.read('s').kind).toBe('failed');
  expect(old.reportFailure).toHaveBeenCalledOnce();
  expect(old.startFailures()).toHaveLength(1);
  expect(lifeStore.row('s', row.seq).state).toBe('queued');
  // After the restart the session still shows the failure: hydrate does not start a row behind its failure barrier.
  const next = host(); await next.owner.signIn('A'); await next.owner.quiescent('s');
  expect(next.owner.read('s').kind).toBe('failed');
  expect(next.dispatch).not.toHaveBeenCalled();
});

it('a start in flight when the host quits holds its row; the next host delivers it and nothing reports a failure', async () => {
  const old = host(); await old.owner.signIn('A');
  const endpoint = Promise.withResolvers<void>();
  old.handshake(() => endpoint.promise);
  const row = old.send('scheduled');
  await vi.waitFor(() => expect(old.owner.read('s').stage?.at).toBe('channel'));
  old.owner.beginHostQuit();
  endpoint.reject(new Error(MCP_CLOSED)); // the shutdown closes the endpoint under the engine
  await old.owner.quiescent('s');
  expect(old.owner.read('s').kind).toBe('dormant');
  expect(lifeStore.read('s').hold).toMatchObject({ reason: 'sign-out', ownerUserId: 'A' });
  expect(lifeStore.row('s', row.seq).state).toBe('queued');
  expect(old.reportFailure).not.toHaveBeenCalled();
  expect(old.startFailures()).toEqual([]);
  expect(old.dispatch).not.toHaveBeenCalled();

  const next = host(); await next.owner.signIn('A'); await next.owner.quiescent('s');
  expect(lifeStore.row('s', row.seq).state).toBe('accepted');
  expect(next.dispatch).toHaveBeenCalledOnce();
  expect(next.dispatch.mock.calls[0]![1].message.id).toBe('scheduled');
  expect(next.reportFailure).not.toHaveBeenCalled();
  await next.owner.signOut();
});

it('while the host quits nothing starts, and a scheduled recovery waits instead of spending a reservation', async () => {
  const old = host(); await old.owner.signIn('A');
  old.owner.beginHostQuit();
  const row = old.send('during-quit');
  await old.owner.quiescent('s');
  expect(old.stages).toEqual([]);
  expect(lifeStore.row('s', row.seq).state).toBe('queued');
  expect(() => old.owner.start('s')).toThrow(/quitting/);
  expect(old.owner.startAfterOutage(() => {})).toEqual([]);
  expect(old.owner.recoverQueuedDelivery('s', 'during-quit', true)).toEqual({ state: 'waiting' });
  expect(old.stages).toEqual([]);

  const next = host(); await next.owner.signIn('A'); await next.owner.quiescent('s');
  expect(lifeStore.row('s', row.seq).state).toBe('accepted');
  expect(next.dispatch).toHaveBeenCalledOnce();
  await next.owner.signOut();
});

it('a start the lifecycle makes on its own during the quit (an engine exit with input waiting) runs no stage', async () => {
  const old = host(); await old.owner.signIn('A');
  const first = old.send('first'); await old.owner.quiescent('s');
  expect(lifeStore.row('s', first.seq).state).toBe('accepted');
  old.owner.beginHostQuit();
  const second = old.send('second'); await old.owner.quiescent('s');
  expect(old.owner.read('s').kind).toBe('ready');
  const stagesBefore = old.stages.length;
  old.exits.at(-1)!({ processExited: true, cause: { name: 'Error', message: 'engine stopped with the host' }, code: 0, signal: null });
  await old.owner.quiescent('s');
  expect(old.stages.length).toBe(stagesBefore);
  expect(old.owner.read('s').kind).toBe('dormant');
  expect(lifeStore.row('s', second.seq).state).toBe('queued');
  expect(old.dispatch).toHaveBeenCalledOnce();
  expect(old.startFailures()).toEqual([]);

  const next = host(); await next.owner.signIn('A'); await next.owner.quiescent('s');
  expect(lifeStore.row('s', second.seq).state).toBe('accepted');
  expect(next.dispatch.mock.calls.map(([, sent]) => sent.message.id)).toEqual(['second']);
  await next.owner.signOut();
});
