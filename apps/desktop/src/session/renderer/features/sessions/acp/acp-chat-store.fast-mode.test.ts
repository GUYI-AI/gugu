// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installAcpChatStoreHost } from './acp-chat-store.test-host';

vi.mock('@renderer/lib/acp/runtime-client', () => ({ getAcpRuntimeClient: async () => ({}) }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
const invokes: Array<{ channel: string; args: unknown[] }> = [];
installAcpChatStoreHost((channel: string, ...args: unknown[]) => {
  invokes.push({ channel, args });
  return Promise.resolve([]);
});
const { AcpChatStore } = await import('./acp-chat-store');
let seq = 0;
beforeEach(() => { invokes.length = 0; });

function makeStore(result: unknown) {
  const store = new AcpChatStore(`conv-fast-${++seq}`, 'project-fast');
  const group = { configId: 'fast', selected: 'off', available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] };
  const setModelOption = vi.fn(async () => result);
  store.session = { config: { current: () => ({ fastMode: group }) },
    sessionState: { current: () => ({ activeTurnId: null }) }, setModelOption } as never;
  return { store, group, setModelOption };
}
const recorded = () => invokes.filter(call => call.channel.includes('recordLiveSessionSetting')).map(call => call.args);

describe('desktop Fast setting bridge', () => {
  it.each([true, false])('sends the native on/off choice and records accepted intent %s', async enabled => {
    const value = enabled ? 'on' : 'off';
    const { store, group, setModelOption } = makeStore({ success: true, data: { status: 'applied', effectiveValue: value, channel: 'acp-config' } });
    expect(store.fastModeGroup).toBe(group);
    await store.setFastMode(enabled);
    expect(setModelOption).toHaveBeenCalledExactlyOnceWith('fast', value);
    expect(recorded()).toEqual([[store.sessionId, { dimension: 'fast', value: enabled }]]);
  });
  it('does not persist a rejected setting', async () => {
    const { store } = makeStore({ success: false, error: new Error('native Fast rejected') });
    await expect(store.setFastMode(true)).resolves.toBeNull();
    expect(recorded()).toEqual([]);
  });
  it('does not claim acceptance while the host still has a pending setting', async () => {
    const { store } = makeStore({ success: true, data: { status: 'pending_next_turn', requestedValue: 'on', channel: 'acp-config' } });
    await store.setFastMode(true);
    expect(recorded()).toEqual([]);
  });
});
