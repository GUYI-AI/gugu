// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSessionListSync, type SessionpageSessionListClient } from '@/session/shared/remote-sessions/session-list-sync';
import { INVENTORY_READ_TIMEOUT_MS, watchInventoryRead } from '@renderer/features/remote-hosts/inventory-read';

const windowState = vi.hoisted(() => ({
  link: 'open',
  listeners: new Set<() => void>(),
  reconnect: vi.fn(),
  client: null as { state(): string; onStateChange(cb: () => void): () => void } | null,
}));
vi.mock('@renderer/lib/machine-clients', () => ({
  machineLinkState: () => windowState.link,
  machineClient: () => windowState.client,
  reconnectMachine: windowState.reconnect,
}));

describe('the first inventory on a remote window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    windowState.link = 'open';
    windowState.client = {
      state: () => windowState.link,
      onStateChange: (cb) => {
        windowState.listeners.add(cb);
        return () => windowState.listeners.delete(cb);
      },
    };
    windowState.reconnect.mockReset().mockImplementation(() => {
      windowState.link = 'closed';
      for (const cb of [...windowState.listeners]) cb();
    });
  });
  afterEach(() => {
    windowState.listeners.clear();
    vi.useRealTimers();
  });

  it.each([
    { projects: false, snapshot: true, recoveries: 1 },
    { projects: true, snapshot: false, recoveries: 1 },
    { projects: false, snapshot: false, recoveries: 1 },
    { projects: true, snapshot: true, recoveries: 0 },
  ])('projects=$projects and snapshot=$snapshot cause $recoveries reconnects', async ({ projects, snapshot, recoveries }) => {
    const read = watchInventoryRead('machine', 'projects');
    const onList = vi.fn();
    const client: SessionpageSessionListClient = {
      subscribeSessionsList: async () => ({ ok: true }),
      unsubscribeSessionsList: async () => ({}),
      subscribeSessionsListEvents: (_device, subscriptionId, emit) => {
        if (snapshot) emit({ subscriptionId, full: { sessions: [], projects: [] } });
        return () => {};
      },
      onLinkChange: () => () => {},
    };
    const sync = startSessionListSync(client, 'machine', {
      watchFirstSnapshot: () => watchInventoryRead('machine', 'sessions snapshot'),
      onList,
    });
    if (projects) read?.received();
    await vi.advanceTimersByTimeAsync(INVENTORY_READ_TIMEOUT_MS * 3);
    expect(windowState.reconnect).toHaveBeenCalledTimes(recoveries);
    expect(onList).toHaveBeenCalledTimes(Number(snapshot));
    if (!projects) expect(read?.current()).toBe(false);
    sync.stop();
    expect(windowState.listeners.size).toBe(0);
  });

  it.each(['projects', 'sessions snapshot'] as const)('gives a slow %s time to finish without the fast read resetting it', async (slow) => {
    const fast = slow === 'projects' ? 'sessions snapshot' : 'projects';
    const startRound = () => {
      windowState.link = 'open';
      const waiting = watchInventoryRead('machine', slow)!;
      watchInventoryRead('machine', fast)!.received();
      return waiting;
    };

    const abandoned = startRound();
    await vi.advanceTimersByTimeAsync(INVENTORY_READ_TIMEOUT_MS);
    expect(windowState.reconnect).toHaveBeenCalledTimes(1);
    const retry = startRound();
    abandoned.received();
    await vi.advanceTimersByTimeAsync(55_000);
    expect(retry.current()).toBe(true);
    retry.received();
    await vi.runAllTimersAsync();
    expect(windowState.reconnect).toHaveBeenCalledTimes(1);

    startRound();
    await vi.advanceTimersByTimeAsync(INVENTORY_READ_TIMEOUT_MS);
    expect(windowState.reconnect).toHaveBeenCalledTimes(2);
  });

  it('doubles the deadline once per recovery, caps it, and requires both missing inventories to arrive', async () => {
    for (const [round, deadline] of [40_000, 80_000, 160_000, 160_000].entries()) {
      windowState.link = 'open';
      const projects = watchInventoryRead('machine', 'projects')!;
      watchInventoryRead('machine', 'sessions snapshot');
      if (round > 0) projects.received();
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(windowState.reconnect).toHaveBeenCalledTimes(round);
      await vi.advanceTimersByTimeAsync(1);
      expect(windowState.reconnect).toHaveBeenCalledTimes(round + 1);
    }
  });

  it('leaves a peer with a known version refusal alone, including one reported during a read', async () => {
    watchInventoryRead('machine', 'projects');
    windowState.link = 'tooOld';
    expect(watchInventoryRead('machine', 'sessions snapshot')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(INVENTORY_READ_TIMEOUT_MS * 2);
    expect(windowState.reconnect).not.toHaveBeenCalled();
    expect(windowState.listeners.size).toBe(0);
  });
});
