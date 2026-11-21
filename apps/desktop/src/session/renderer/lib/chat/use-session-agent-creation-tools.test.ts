import { beforeEach, describe, expect, it, vi } from 'vitest';

// The creation-tool catalog is a device replica (was an effect per composer, starting from `[]` each mount): read
// once, read again when main says an agent's capabilities changed.
const mocks = vi.hoisted(() => ({ load: vi.fn(), changed: null as null | (() => void) }));
vi.mock('@/lib/agentCreationTools', () => ({ loadLocalAgentCreationTools: mocks.load }));
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: (_channel: unknown, cb: () => void) => { mocks.changed = cb; return () => { mocks.changed = null; }; } },
}));
vi.mock('@/components/Avatar', () => ({ Avatar: () => null }));
vi.mock('@/lib/avatarIdentity', () => ({ useAvatarIdentity: () => null }));

const { queryClient } = await import('@/lib/replica');
const { agentCreationTools } = await import('./use-session-agent-creation-tools');

beforeEach(() => {
  queryClient.clear();
  mocks.load.mockReset();
});

describe('agent creation tools', () => {
  it('a failed catalog is an error, ❌ an empty catalog', async () => {
    mocks.load.mockRejectedValueOnce(new Error('Electron returned no reachable agent creation tools'));
    await agentCreationTools.prefetch();
    expect(agentCreationTools.peek().state).toBe('error');
  });

  it('is read once and kept for the next composer', async () => {
    mocks.load.mockResolvedValue([{ id: 'claude', engine: 'claude', label: 'Claude', icon: 'x' }]);
    await agentCreationTools.fetch();
    await agentCreationTools.fetch();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(agentCreationTools.peek()).toMatchObject({ state: 'value', stale: false });
  });
});
