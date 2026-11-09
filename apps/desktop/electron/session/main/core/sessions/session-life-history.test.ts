import { describe, expect, it, vi } from 'vitest';
import { SessionLife, type LifeStore } from './session-life';
import type { LegAdapter } from './session-life-adapter';
import type { Gen, StageName, StageOut } from '@gugu/core/local/session-life/types';

function fixture() {
  const store: LifeStore = { read: () => ({ archived: false, hold: null }), pending: () => ({ queued: [], dispatching: [] }),
    unaccepted: vi.fn(() => []), enqueue: vi.fn(), row: vi.fn(), commit: vi.fn(), claim: () => [],
    acceptedUnsettled: () => [], settleRead: vi.fn(), remove: vi.fn() };
  const adapter: LegAdapter = { leg: 'acp', timing: 'next-tool-call',
    async run<K extends StageName>(at: K, _have: unknown, ctx: { gen: Gen }): Promise<StageOut[K]> {
      return (at === 'identity' ? { kind: 'bound', agentUserId: 'agent' } : { timing: 'next-tool-call', gen: ctx.gen }) as StageOut[K];
    }, dispatch: vi.fn(), teardown: vi.fn(async () => {}), onExit: () => () => {} };
  const life = new SessionLife({ store: () => store, adapter: () => adapter, sessions: () => [], forks: () => [], allForks: () => [],
    parentOf: () => null, ownedBy: async () => true, markRead: async () => {}, reportFailure: async () => {},
    publish: vi.fn(), removed: vi.fn(), failed: (_sessionId, error) => { throw error; }, logger: { info: vi.fn() }, now: Date.now });
  return { life, store, adapter };
}
describe('stopped lifecycle history fences', () => {
  it('captures only a dormant entry without enumerating or serializing its input queue', async () => {
    const { life, store } = fixture();
    const proof = await life.stoppedReadFence('s');
    expect(proof?.()).toBe(true); expect(store.unaccepted).not.toHaveBeenCalled();
    await life.signIn('person'); life.start('s'); await life.quiescent('s');
    expect(life.status('s').kind).toBe('ready');
    expect(await life.stoppedReadFence('s')).toBeNull();
    await life.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
  });
  it('detects a complete start-stop ABA before a deferred source page returns', async () => {
    const { life } = fixture(); await life.signIn('person');
    const proof = await life.stoppedReadFence('s'); expect(proof?.()).toBe(true);
    life.start('s'); await life.quiescent('s');
    await life.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
    expect(life.status('s').kind).toBe('dormant'); expect(proof?.()).toBe(false);
  });
  it('rejects an ABA during preparation instead of recapturing the newer dormant version', async () => {
    const { life } = fixture(); await life.signIn('person');
    const preparing = life.stoppedReadFence('s');
    life.start('s');
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'scope_changed' });
    await life.quiescent('s'); await life.interrupt('s', { k: 'interrupt', reason: 'user-stop' });
    await rejected; expect(life.status('s').kind).toBe('dormant');
  });
  it('rejects a removed/recreated entry and an account restart despite the same stopped kind', async () => {
    const { life } = fixture(); await life.signIn('person');
    const deleted = await life.stoppedReadFence('s');
    await life.interrupt('s', { k: 'interrupt', reason: 'delete' });
    const recreated = await life.stoppedReadFence('s');
    expect(deleted?.()).toBe(false); expect(recreated?.()).toBe(true);
    await life.signOut(); await life.signIn('person'); await life.stoppedReadFence('s');
    expect(recreated?.()).toBe(false);
  });
});
