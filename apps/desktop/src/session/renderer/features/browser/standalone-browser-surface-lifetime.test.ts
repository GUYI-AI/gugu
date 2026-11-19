// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStandaloneSurfaceState, mountStandaloneBrowserSurface } from './standalone-browser-surface-lifetime';

const mocks = vi.hoisted(() => ({
  mountPage: vi.fn(), watch: vi.fn(async () => {}), unwatch: vi.fn(async () => ({})),
  send: vi.fn(), control: vi.fn(async () => ({})), off: vi.fn(), mountProjection: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { browser: { mountPage: mocks.mountPage, watchStandalonePage: mocks.watch, unwatchTaskPage: mocks.unwatch,
    sendTaskPage: mocks.send, controlTaskPage: mocks.control } },
  events: { on: () => mocks.off },
}));
vi.mock('@/session/app-runtime/projection-view', () => ({ mountProjection: mocks.mountProjection }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const mounted = { success: true, ready: true, state: { url: 'http://localhost', title: 'Fixture', canGoBack: false, canGoForward: false } };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function start() {
  const viewport = document.createElement('div'), picture = document.createElement('div');
  const onHandle = vi.fn(), changes = createStandaloneSurfaceState();
  return { changes, onHandle, lifetime: mountStandaloneBrowserSurface({ browserId: 'fixture', partition: 'persist:fixture',
    initialUrl: 'http://localhost', visible: true, viewport, picture, changes, onHandle }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});

describe('standalone page stream lifetime', () => {
  it('does not mount a picture or publish a handle after the surface has closed', async () => {
    const pending = deferred<typeof mounted>();
    mocks.mountPage.mockReturnValueOnce(pending.promise);
    const view = start();
    view.lifetime.close();
    pending.resolve(mounted);
    await flush();
    expect(mocks.mountProjection).not.toHaveBeenCalled();
    expect(view.onHandle.mock.calls).toEqual([[null]]);
    expect(mocks.off).toHaveBeenCalledOnce();
  });

  it('closes a late watch after hiding, and ignores its frames when a fresh watch is shown', async () => {
    mocks.mountPage.mockResolvedValueOnce(mounted);
    const pending = deferred<{ close(): Promise<void> }>();
    const oldClose = vi.fn(async () => {}), newClose = vi.fn(async () => {});
    mocks.mountProjection.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ close: newClose });
    const view = start();
    await flush();
    const first = mocks.mountProjection.mock.calls[0][3];
    view.lifetime.setVisible(false);
    view.lifetime.setVisible(true);
    await flush();
    const second = mocks.mountProjection.mock.calls[1][3];
    second.state('live');
    second.painted({ width: 800, height: 600, sequence: 2 });
    first.state('closed');
    first.painted({ width: 1, height: 1, sequence: 1 });
    pending.resolve({ close: oldClose });
    await flush();
    expect(oldClose).toHaveBeenCalledOnce();
    expect(view.changes.get()).toMatchObject({ state: 'live', frame: { width: 800, height: 600 } });
    view.lifetime.close();
    expect(newClose).toHaveBeenCalledOnce();
  });

  it('exposes a mount failure without claiming that the page is ready', async () => {
    mocks.mountPage.mockResolvedValueOnce({ success: false, error: 'The engine could not start' });
    const view = start();
    await flush();
    expect(view.changes.get()).toMatchObject({ state: 'closed', error: new Error('The engine could not start') });
    expect(view.onHandle).not.toHaveBeenCalled();
    expect(mocks.mountProjection).not.toHaveBeenCalled();
    view.lifetime.close();
  });
});
