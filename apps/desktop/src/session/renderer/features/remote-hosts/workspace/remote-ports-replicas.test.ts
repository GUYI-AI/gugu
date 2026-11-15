import { beforeEach, describe, expect, it, vi } from 'vitest';

// The ports a machine forwards are one replica read by the ports tab and the browser tab's address bar (remote-forward-cache
// is gone): main's "table changed" refreshes it, and the address bar's one-moment lookup reads what is held.
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  list: vi.fn(),
  listening: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (_channel: unknown, listener: () => void, deviceId: string) => {
      mocks.listeners.set(deviceId, listener);
      return () => { mocks.listeners.delete(deviceId); };
    },
  },
  rpc: { remotePorts: { list: mocks.list } },
  rpcOn: () => ({ machine: { listeningPorts: mocks.listening } }),
}));

const { followRendererSession, queryClient } = await import('@/lib/replica');
const { machineListeningPorts, remoteForLocalPort, remotePortForwards, watchRemotePorts } = await import('./remote-ports-replicas');

const table = (localPort: number) => ({ success: true, data: { forwards: [{ remotePort: 5173, localPort, phase: 'ready', holders: ['manual'] }], detected: [] } });

beforeEach(() => {
  queryClient.clear();
  mocks.listeners.clear();
  mocks.list.mockReset();
  mocks.listening.mockReset();
  followRendererSession('SIGNED_IN', 'tester');
});

describe('remote port forwards', () => {
  it('the address bar knows no forward until the table is read, then the one read', async () => {
    mocks.list.mockResolvedValueOnce(table(15173));
    expect(remoteForLocalPort('dev-1', 15173)).toBeNull();
    await remotePortForwards.fetch('dev-1');
    expect(remoteForLocalPort('dev-1', 15173)).toBe(5173);
    expect(remoteForLocalPort('dev-1', 9)).toBeNull();
  });

  it('main saying the table changed reads it again, one subscription per machine', async () => {
    mocks.list.mockResolvedValueOnce(table(15173)).mockResolvedValueOnce(table(25173));
    const stopA = watchRemotePorts('dev-1');
    const stopB = watchRemotePorts('dev-1');
    await remotePortForwards.fetch('dev-1');
    mocks.listeners.get('dev-1')!();
    await vi.waitFor(() => expect(remoteForLocalPort('dev-1', 25173)).toBe(5173));
    stopA();
    expect(mocks.listeners.has('dev-1')).toBe(true);
    stopB();
    expect(mocks.listeners.has('dev-1')).toBe(false);
  });

  it('a failed listing is an error, ❌ an empty table', async () => {
    mocks.list.mockResolvedValueOnce({ success: false, error: { type: 'invalid' } });
    await remotePortForwards.prefetch('dev-1');
    expect(remotePortForwards.peek('dev-1').state).toBe('error');
    mocks.listening.mockRejectedValueOnce(new Error('unreachable'));
    await machineListeningPorts.prefetch('dev-1');
    expect(machineListeningPorts.peek('dev-1').state).toBe('error');
  });
});
