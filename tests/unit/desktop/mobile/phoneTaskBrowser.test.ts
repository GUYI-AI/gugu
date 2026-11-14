import { afterEach, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }));
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: rpc.call, subscribeDeviceRpcEvents: rpc.subscribe }));
import { phoneTaskBrowserHost } from '@/mobile/agent-watch/phone-task-browser-host';

afterEach(() => vi.clearAllMocks());

it('keeps the page, selection and capture on one authenticated device/session watch and reopens it after reconnect', async () => {
  let hear!: (payload: unknown) => void;
  let reconnect!: (rejoin: boolean) => void;
  const off = vi.fn();
  rpc.subscribe.mockImplementation((_device, listener, options) => { hear = listener; reconnect = options.onChannelResubscribed; return off; });
  rpc.call.mockResolvedValue({ result: {} });
  const page = vi.fn(), packet = vi.fn();
  const transport = phoneTaskBrowserHost('owned-device', 'owned-session', page);
  const stop = transport.host.onProjection!(packet);
  await transport.host.projection!.watch({ id: 'page', watchId: 'watch-12345' });
  expect(rpc.call).toHaveBeenCalledWith('owned-device', 'appProjection.watch', { watch: 'watch-12345', session: 'owned-session', page: true }, expect.any(Object));
  hear({ type: 'appProjection.pageState', watch: 'other-watch', state: { url: 'https://other.example/' } });
  expect(page).not.toHaveBeenCalled();
  hear({ payload: { type: 'appProjection.pageState', watch: 'watch-12345', state: { url: 'https://example.org/' } } });
  expect(page).toHaveBeenCalledWith({ url: 'https://example.org/' });
  const inspection = { target: { url: 'https://example.org/', text: 'Evidence' }, screenshot: 'data:image/png;base64,cGFnZQ==' };
  rpc.call.mockResolvedValueOnce({ result: { inspection } });
  expect(await transport.control({ action: 'annotate', query: { x: 0.1, y: 0.2, width: 0, height: 0 }, capture: true })).toEqual(inspection);
  reconnect(true);
  await Promise.resolve();
  expect(rpc.call.mock.calls.at(-1)?.[1]).toBe('appProjection.watch');
  await transport.host.projection!.unwatch({ watchId: 'watch-12345' });
  await expect(transport.control({ action: 'reload' })).rejects.toThrow('not watched');
  stop(); expect(off).toHaveBeenCalledOnce();
});
