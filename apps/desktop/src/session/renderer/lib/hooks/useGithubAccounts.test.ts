import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GitHub accounts read through the library host kept under its key;
 * an assistant panel still settling is asked again after a pause (1 s, 2 s), ❌ at once.
 */
const hosts = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@renderer/features/library/library-host', () => ({
  keepLibraryHost: (host: { key: string }) => { hosts.set(host.key, host); return host; },
  libraryHostOf: (key: string) => { const host = hosts.get(key); if (!host) throw new Error(`No library host is kept for ${key}`); return host; },
  peekLibraryHost: (key: string) => hosts.get(key),
  useLibraryHost: vi.fn(),
}));
vi.mock('@gugu/core/cloud/assistantPanelRead', () => ({ retryAssistantPanelRead: (count: number) => count < 2 }));
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: vi.fn() }));
vi.mock('@/components/assistant/assistant-app-client', () => ({ reportAssistantAppChange: vi.fn() }));
vi.mock('@/store/devicesCache', () => ({ cachedDevicesAccount: vi.fn() }));
vi.mock('@/components/connections/connection-replicas', () => ({ CONNECTIONS: 'connections' }));

const { queryClient } = await import('@/lib/replica');
const { githubAccounts } = await import('./useGithubAccounts');

beforeEach(() => { queryClient.clear(); hosts.clear(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('githubAccounts', () => {
  it('reads through the host kept under the key, asking a settling assistant panel again after a pause', async () => {
    const listAccounts = vi.fn().mockRejectedValueOnce(new Error('settling')).mockResolvedValueOnce([{ id: 'gh-1' }]);
    hosts.set('panel:1', { key: 'panel:1', assistantPanelExpected: true, github: { listAccounts } });
    const read = githubAccounts.fetch('panel:1');
    await vi.advanceTimersByTimeAsync(0);
    expect(listAccounts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(listAccounts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toEqual([{ id: 'gh-1' }]);
    expect(listAccounts).toHaveBeenCalledTimes(2);
  });
});
