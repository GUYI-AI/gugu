import { noopLogger } from '@gugu/session-shared/logger';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import type { Gen, StageName, StageOut } from '@gugu/core/local/session-life/types';
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

/** `platform` is the model-access stage: it answers as the test says (refuse, hang, or pass). */
function rig(timing: 'next-tool-call' | 'idle-only' = 'next-tool-call') {
  let platform: () => Promise<void> = async () => {};
  const dispatch = vi.fn<LegAdapter['dispatch']>(async () => ({ result: 'accepted', nativeReceiptId: 'native' }));
  const teardown = vi.fn<LegAdapter['teardown']>(async () => {});
  const owner = new SessionLife({ logger: noopLogger, sessions: () => ['s'], store: () => lifeStore,
    adapter: () => ({ leg: 'acp', timing,
      async run<K extends StageName>(at: K, _have: unknown, ctx: { gen: Gen }): Promise<StageOut[K]> {
        if (at === 'platform') await platform();
        return (at === 'identity' ? { kind: 'bound', agentUserId: 'agent' } : { at, gen: ctx.gen, timing }) as StageOut[K];
      }, dispatch, teardown,
      onExit: () => () => {} }),
    forks: () => [], allForks: () => [], parentOf: () => null, ownedBy: async () => true,
    markRead: async () => {}, reportFailure: async () => {}, publish: () => {}, removed: () => {}, failed: vi.fn(), now: Date.now });
  return { owner, dispatch, teardown, platform: (next: () => Promise<void>) => { platform = next; },
    send: (id: string) => owner.enqueue({ sessionId: 's', messageId: id, text: id, kind: 'ordinary' }) };
}

it('starts a session the outage failed once the backend is back, after clearing its issue backoff, and only that one', async () => {
  const r = rig(); await r.owner.signIn('A');
  r.platform(async () => { throw new Error('gugu-models:unreachable'); });
  const row = r.send('during-outage');
  await r.owner.quiescent('s');
  expect(r.owner.read('s').kind).toBe('failed');
  expect(r.dispatch).not.toHaveBeenCalled();

  r.platform(async () => {});
  const cleared: string[] = [];
  expect(r.owner.startAfterOutage(id => cleared.push(id))).toEqual(['s']);
  expect(cleared).toEqual(['s']);
  await r.owner.quiescent('s');
  expect(lifeStore.row('s', row.seq).state).toBe('accepted');
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  // A running session is not started again.
  expect(r.owner.startAfterOutage(() => {})).toEqual([]);
  await r.owner.signOut();
});

it('a stop while the model-access stage never answers settles at once; a late answer is torn down', async () => {
  const r = rig(); await r.owner.signIn('A');
  let answer!: () => void;
  r.platform(() => new Promise<void>(resolve => { answer = resolve; }));
  r.send('stuck');
  await vi.waitFor(() => expect(r.owner.read('s').stage?.at).toBe('platform'));
  await r.owner.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
  await r.owner.quiescent('s');
  expect(r.owner.read('s').kind).toBe('dormant');
  const teardowns = r.teardown.mock.calls.length;
  answer();
  await vi.waitFor(() => expect(r.teardown.mock.calls.length).toBe(teardowns + 1));
  expect(r.teardown.mock.calls.at(-1)![0]).toHaveProperty('platform');
  expect(r.dispatch).not.toHaveBeenCalled();
  await r.owner.signOut();
});

it('recovers one scheduled queued identity after a start failure without changing duplicate-enqueue semantics', async () => {
  const r = rig(); await r.owner.signIn('A');
  r.platform(async () => { throw new Error('transient startup unavailable'); });
  const row = r.send('scheduled-stable');
  await r.owner.quiescent('s');
  r.send('scheduled-stable');
  await r.owner.quiescent('s');
  expect(r.owner.read('s').kind).toBe('failed');
  expect(r.owner.recoverQueuedDelivery('s', 'different-message', true)).toEqual({ state: 'waiting' });
  expect(r.owner.recoverQueuedDelivery('s', 'scheduled-stable', false))
    .toEqual({ state: 'needed', cause: 'transient startup unavailable' });
  r.platform(async () => {});
  expect(r.owner.recoverQueuedDelivery('s', 'scheduled-stable', true))
    .toEqual({ state: 'started', cause: 'transient startup unavailable' });
  expect(r.owner.recoverQueuedDelivery('s', 'scheduled-stable', true)).toEqual({ state: 'waiting' });
  await r.owner.quiescent('s');
  expect(lifeStore.row('s', row.seq).state).toBe('accepted');
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  expect(r.dispatch.mock.calls[0]![1].message.id).toBe('scheduled-stable');
  r.send('scheduled-stable');
  expect(r.owner.recoverQueuedDelivery('s', 'scheduled-stable', true)).toEqual({ state: 'waiting' });
  await r.owner.quiescent('s');
  expect(r.dispatch).toHaveBeenCalledTimes(1);
  await r.owner.signOut();
});

it('does not restart a scheduled input after an unknown ACK outcome', async () => {
  const r = rig(); await r.owner.signIn('A');
  r.dispatch.mockRejectedValueOnce(new Error('ACK lost after dispatch'));
  const row = r.send('unknown-ack');
  await r.owner.quiescent('s');
  expect(lifeStore.row('s', row.seq).state).toBe('unknown');
  r.send('unknown-ack');
  expect(r.owner.recoverQueuedDelivery('s', 'unknown-ack', true)).toEqual({ state: 'waiting' });
  expect(lifeStore.row('s', row.seq).state).toBe('unknown');
  expect(r.dispatch).toHaveBeenCalledOnce();
  await r.owner.signOut();
});

it('waits for a busy recipient without restarting it or duplicating its queued input', async () => {
  const r = rig('idle-only'); await r.owner.signIn('A');
  r.send('current-turn'); await r.owner.quiescent('s');
  const queued = r.send('scheduled-after-current-turn');
  await r.owner.quiescent('s');
  expect(lifeStore.row('s', queued.seq).state).toBe('queued');
  expect(r.owner.recoverQueuedDelivery('s', 'scheduled-after-current-turn', true)).toEqual({ state: 'waiting' });
  r.send('scheduled-after-current-turn');
  expect(r.dispatch).toHaveBeenCalledOnce();
  r.owner.turn('s', false); await r.owner.quiescent('s');
  expect(lifeStore.row('s', queued.seq).state).toBe('accepted');
  expect(r.dispatch.mock.calls.map(call => call[1].message.id)).toEqual(['current-turn', 'scheduled-after-current-turn']);
  await r.owner.signOut();
});

it('does not automate a failed stage that requires a person', async () => {
  const r = rig(); await r.owner.signIn('A');
  r.platform(async () => { throw Object.assign(new Error('sign-in required'), { awaitsPerson: true }); });
  r.send('held-sign-in'); await r.owner.quiescent('s');
  expect(r.owner.recoverQueuedDelivery('s', 'held-sign-in', true))
    .toEqual({ state: 'blocked', cause: 'sign-in required' });
  expect(r.owner.read('s').kind).toBe('failed');
  expect(r.dispatch).not.toHaveBeenCalled();
  await r.owner.signOut();
});

it('never crosses a user stop to recover an earlier queued schedule', async () => {
  const r = rig(); await r.owner.signIn('A');
  r.platform(() => new Promise<void>(() => {}));
  r.send('before-user-stop');
  await vi.waitFor(() => expect(r.owner.read('s').stage?.at).toBe('platform'));
  await r.owner.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
  await r.owner.quiescent('s');
  expect(r.owner.recoverQueuedDelivery('s', 'before-user-stop', true))
    .toEqual({ state: 'blocked', cause: 'The session is held: user-stop' });
  expect(r.dispatch).not.toHaveBeenCalled();
  await r.owner.signOut();
});
