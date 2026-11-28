// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOST_WS_STALE_MS } from '@shared/lib/ipc/host-ws-protocol';
import { startSessionListSync, type SessionpageSessionListClient } from '@/session/shared/remote-sessions/session-list-sync';
import { watchInventoryRead } from '@renderer/features/remote-hosts/inventory-read';

const windowState = vi.hoisted(() => ({
  link: 'open',
  listeners: new Set<() => void>(),
  reconnect: vi.fn(),
}));
vi.mock('@renderer/lib/machine-clients', () => ({
  machineLinkState: () => windowState.link,
  machineClient: () => ({
    state: () => 'open',
    onStateChange: (cb: () => void) => {
      windowState.listeners.add(cb);
      return () => windowState.listeners.delete(cb);
    },
  }),
  reconnectMachine: windowState.reconnect,
}));

describe('the first inventory on a remote window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    windowState.link = 'open';
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
      watchFirstSnapshot: () => watchInventoryRead('machine', 'sessions snapshot')?.finish,
      onList,
    });
    if (projects) read?.finish();
    await vi.advanceTimersByTimeAsync(HOST_WS_STALE_MS * 3);
    expect(windowState.reconnect).toHaveBeenCalledTimes(recoveries);
    expect(onList).toHaveBeenCalledTimes(Number(snapshot));
    if (!projects) expect(read?.current()).toBe(false);
    sync.stop();
    expect(windowState.listeners.size).toBe(0);
  });

  it('leaves a peer with a known version refusal alone, including one reported during a read', async () => {
    watchInventoryRead('machine', 'projects');
    windowState.link = 'tooOld';
    expect(watchInventoryRead('machine', 'sessions snapshot')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(HOST_WS_STALE_MS * 2);
    expect(windowState.reconnect).not.toHaveBeenCalled();
    expect(windowState.listeners.size).toBe(0);
  });
});
