import { expect, it, vi } from 'vitest';
import { SessionLife, type LifeStore } from './session-life';
import type { LegAdapter } from './session-life-adapter';
import type { Gen, StageName, StageOut } from '@gugu/core/local/session-life/types';

// A start stage that rejects (a wire-validation error from the runtime, an unreachable worker) must reach the
// host's failure log. The lifecycle transition line is info, below the default level, so it alone is silence.
it('reports a rejected start stage through the failure port, naming the stage and the cause', async () => {
  const store: LifeStore = { read: () => ({ archived: false, hold: null }), pending: () => ({ queued: [], dispatching: [] }),
    unaccepted: vi.fn(() => []), enqueue: vi.fn(), row: vi.fn(), commit: vi.fn(), claim: () => [],
    acceptedUnsettled: () => [], settleRead: vi.fn(), remove: vi.fn() };
  const adapter: LegAdapter = { leg: 'acp', timing: 'next-tool-call',
    async run<K extends StageName>(at: K, _have: unknown, ctx: { gen: Gen }): Promise<StageOut[K]> {
      if (at === 'channel') throw new Error('input.sessionMeta.claudeCode.options.settings: expected string, received object');
      return (at === 'identity' ? { kind: 'bound', agentUserId: 'agent' } : { timing: 'next-tool-call', gen: ctx.gen }) as StageOut[K];
    }, dispatch: vi.fn(), teardown: vi.fn(async () => {}), onExit: () => () => {} };
  const failed = vi.fn();
  const life = new SessionLife({ store: () => store, adapter: () => adapter, sessions: () => [], forks: () => [], allForks: () => [],
    parentOf: () => null, ownedBy: async () => true, markRead: async () => {}, reportFailure: async () => {},
    publish: vi.fn(), removed: vi.fn(), failed, logger: { info: vi.fn() }, now: Date.now });
  await life.signIn('person'); life.start('s'); await life.quiescent('s');

  expect(life.status('s').kind).not.toBe('ready');
  expect(failed).toHaveBeenCalledTimes(1);
  expect(failed.mock.calls[0]?.[0]).toBe('s');
  expect(String(failed.mock.calls[0]?.[1])).toContain("Start stage 'channel' failed: input.sessionMeta.claudeCode.options.settings");
});
