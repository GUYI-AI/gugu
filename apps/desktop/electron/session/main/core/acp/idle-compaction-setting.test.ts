import { describe, expect, it, vi } from 'vitest';

const sessions = vi.hoisted(() => ({ idleCompaction: true }));
vi.mock('../settings/settings-service', () => ({ appSettingsService: { get: vi.fn(async () => ({ ...sessions })) } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

import { pushIdleCompactionSetting } from './idle-compaction-setting';

describe('#3005 idle compaction setting reaches the ACP runtime', () => {
  it('sends the stored switch, never spawns a runtime, and keeps a failed push out of the caller', async () => {
    const client = { setIdleCompaction: vi.fn(async () => ({})) };
    await pushIdleCompactionSetting(client);
    expect(client.setIdleCompaction).toHaveBeenLastCalledWith({ enabled: true });
    sessions.idleCompaction = false;
    await pushIdleCompactionSetting(client);
    expect(client.setIdleCompaction).toHaveBeenLastCalledWith({ enabled: false });
    await expect(pushIdleCompactionSetting(null)).resolves.toBeUndefined();
    client.setIdleCompaction.mockRejectedValueOnce(new Error('worker gone'));
    await expect(pushIdleCompactionSetting(client)).resolves.toBeUndefined();
  });
});
