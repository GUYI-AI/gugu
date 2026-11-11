import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1928 The panel's change word for an App watching the assistant's schedules: one channel per account on a connection of
 * its own (never main's client, whose same-topic channel realtime-js would hand back), filtered by assistant, everyone
 * told again on (re)subscription, closed with its last watch.
 */
const state = vi.hoisted(() => ({
  token: 'owner-a' as string | null,
  clients: [] as { channels: { topic: string; options: unknown; on: ReturnType<typeof vi.fn>; fire?: (message: unknown) => void }[];
    disconnect: ReturnType<typeof vi.fn>; removeChannel: ReturnType<typeof vi.fn>; token: () => Promise<string | null> }[],
  subscriptions: [] as { label: string; status: (status: string) => void; off: ReturnType<typeof vi.fn> }[],
}));
vi.mock('./account-token', () => ({ currentAccountAccessToken: async () => state.token }));
vi.mock('@gugu/core', () => ({ userIdFromSupabaseAccessToken: (token: string) => token }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('../../../../supabase', () => ({
  createElectronRealtimeClient: (token: () => Promise<string | null>) => {
    const client = {
      token, channels: [] as (typeof state.clients)[number]['channels'], disconnect: vi.fn(), removeChannel: vi.fn(),
      realtime: { disconnect: () => client.disconnect(), setAuth: vi.fn() },
      channel(topic: string, options: unknown) {
        const channel = { topic, options, on: vi.fn(), fire: undefined as ((message: unknown) => void) | undefined };
        channel.on.mockImplementation((_kind: string, _filter: unknown, fn: (message: unknown) => void) => { channel.fire = fn; return channel; });
        client.channels.push(channel);
        return channel;
      },
    };
    state.clients.push(client);
    return client;
  },
}));
vi.mock('../../../../realtime-channel', () => ({
  subscribeAuthenticatedElectronRealtimeChannel: async (_client: unknown, _channel: unknown, options: { label: string; onStatus(status: string): void }) => {
    const off = vi.fn(async () => undefined);
    state.subscriptions.push({ label: options.label, status: options.onStatus, off });
    return off;
  },
}));

const { onAssistantPanelChanged } = await import('./assistant-panel-changes');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  state.clients.length = 0;
  state.subscriptions.length = 0;
  state.token = 'owner-a';
});

describe('the assistant panel change word', () => {
  it('one channel per account on its own connection, told per assistant and on each subscription, closed with its last watch', async () => {
    const mine = vi.fn();
    const other = vi.fn();
    const stopMine = onAssistantPanelChanged('owner-a', 'assistant-1', mine);
    const stopOther = onAssistantPanelChanged('owner-a', 'assistant-2', other);
    await flush();
    expect(state.clients).toHaveLength(1);
    const [channel] = state.clients[0]!.channels;
    expect(channel).toMatchObject({ topic: 'gugu:user:owner-a:events', options: { config: { private: true } } });
    expect(channel!.on).toHaveBeenCalledWith('broadcast', { event: 'assistant_panel_changed' }, expect.any(Function));
    channel!.fire!({ payload: { assistantId: 'assistant-1', revision: '12' } });
    channel!.fire!({ payload: { revision: '13' } });
    channel!.fire!({});
    expect(mine).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    // (Re)subscribed: words may have been missed, everyone checks.
    state.subscriptions[0]!.status('SUBSCRIBED');
    expect(mine).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledOnce();
    // Its token is this account's only.
    expect(await state.clients[0]!.token()).toBe('owner-a');
    state.token = 'owner-b';
    expect(await state.clients[0]!.token()).toBeNull();
    stopMine();
    stopMine();
    expect(state.subscriptions[0]!.off).not.toHaveBeenCalled();
    stopOther();
    await flush();
    expect(state.subscriptions[0]!.off).toHaveBeenCalledOnce();
    expect(state.clients[0]!.disconnect).toHaveBeenCalledOnce();
    // The next watch opens a fresh one.
    const again = onAssistantPanelChanged('owner-a', 'assistant-1', vi.fn());
    await flush();
    expect(state.clients).toHaveLength(2);
    again();
  });
});
