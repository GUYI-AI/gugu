import { QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A machine's install state that cannot be read ends in an error after its retries, ❌ unknown for ever. */
const io = vi.hoisted(() => ({ statuses: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: () => ({ agents: { listAgentInstallationStatus: io.statuses } }),
  rpc: {},
  events: { on: () => () => {} },
}));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: vi.fn() }));

const { followRendererSession, queryClient } = await import('@/lib/replica');
const { agentInstallationStatus } = await import('./agent-replicas');

beforeEach(() => {
  queryClient.clear();
  followRendererSession('SIGNED_IN', 'tester');
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('agent readings that keep failing', () => {
  it('the install state is an error once its retries are spent', async () => {
    io.statuses.mockRejectedValue(new Error('machine unreachable'));
    const off = new QueryObserver(queryClient, agentInstallationStatus.options(agentInstallationStatus.key(null)!) as never).subscribe(() => {});
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(30_000);
    expect(agentInstallationStatus.peek(null)).toMatchObject({ state: 'error' });
    expect(io.statuses).toHaveBeenCalledTimes(4);
    off();
  });
});
