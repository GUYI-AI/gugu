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
function rig() {
  let platform: () => Promise<void> = async () => {};
  const dispatch = vi.fn<LegAdapter['dispatch']>(async () => ({ result: 'accepted', nativeReceiptId: 'native' }));
  const teardown = vi.fn<LegAdapter['teardown']>(async () => {});
  const owner = new SessionLife({ logger: noopLogger, sessions: () => ['s'], store: () => lifeStore,
    adapter: () => ({ leg: 'acp', timing: 'next-tool-call',
      async run<K extends StageName>(at: K, _have: unknown, ctx: { gen: Gen }): Promise<StageOut[K]> {
        if (at === 'platform') await platform();
        return (at === 'identity' ? { kind: 'bound', agentUserId: 'agent' } : { at, gen: ctx.gen, timing: 'next-tool-call' }) as StageOut[K];
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
