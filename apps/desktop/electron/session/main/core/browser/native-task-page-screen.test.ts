import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ pages: vi.fn(), acquire: vi.fn(), warn: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { warn: mocks.warn } }));
vi.mock('./browser-webcontents-registry', () => ({ browserWebContentsRegistry: { browsersOfSession: mocks.pages } }));
vi.mock('./browser-page-runtime', () => ({ acquireBrowserPage: mocks.acquire }));
import { nativeTaskPageForScreen } from './native-task-page-screen';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('watches only an existing owned tab, preserves its layout, and releases only its own rendering lease', async () => {
  vi.useFakeTimers();
  const image = { isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toJPEG: () => Buffer.from('page'), toPNG: () => Buffer.from('page') };
  const page = Object.assign(new EventEmitter(), {
    capturePage: vi.fn(async () => image), executeJavaScript: vi.fn(async () => ({ width: 800, height: 600 })),
    isDestroyed: () => false, getURL: () => 'https://example.org/', getTitle: () => 'Example', isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false }, getZoomFactor: () => 2, sendInputEvent: vi.fn(),
  });
  const lease = { ready: Promise.resolve(), setActive: vi.fn(), dispose: vi.fn(), snapshot: vi.fn(async () => image) };
  mocks.pages.mockImplementation((session: string) => session === 'owned' ? [{ browserId: 'page', webContents: page }] : []);
  mocks.acquire.mockReturnValue(lease);
  expect(nativeTaskPageForScreen('other')).toBeNull();
  const screen = nativeTaskPageForScreen('owned')!;
  const publish = vi.fn();
  await screen.startScreen(publish);
  expect(publish).toHaveBeenCalledWith({ data: Buffer.from('page').toString('base64'), width: 800, height: 600 });
  expect(lease.setActive).toHaveBeenCalledWith(true);
  await screen.control({ action: 'resize', width: 390, height: 700, scale: 2 });
  expect(page.executeJavaScript).toHaveBeenCalledTimes(1);
  await screen.input('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 150, button: 'left' });
  expect(page.sendInputEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'mouseDown', x: 200, y: 300 }));
  await screen.stopScreen();
  await vi.advanceTimersByTimeAsync(1000);
  expect(lease.snapshot).toHaveBeenCalledTimes(1);
  expect(page.capturePage).not.toHaveBeenCalled();
  expect(lease.dispose).toHaveBeenCalledTimes(1);
  expect(page.listenerCount('did-navigate')).toBe(0);
});

it('recovers a live tab after its first native capture rejects and stops retrying when its viewer closes', async () => {
  vi.useFakeTimers();
  const image = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 900 }), toJPEG: () => Buffer.from('real frame') };
  const page = Object.assign(new EventEmitter(), {
    executeJavaScript: vi.fn(async () => ({ width: 1280, height: 900 })), isDestroyed: () => false,
  });
  const lease = { ready: Promise.resolve(), setActive: vi.fn(), dispose: vi.fn(),
    snapshot: vi.fn().mockRejectedValueOnce(new Error('UnknownVizError')).mockResolvedValue(image) };
  mocks.pages.mockReturnValue([{ browserId: 'page', webContents: page }]); mocks.acquire.mockReturnValue(lease);
  const screen = nativeTaskPageForScreen('owned')!, publish = vi.fn(), destroyed = vi.fn();
  screen.once('destroyed', destroyed);
  await screen.startScreen(publish);
  expect(publish).not.toHaveBeenCalled(); expect(destroyed).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('Could not watch the task browser tab', { error: 'Error: UnknownVizError' });
  await vi.advanceTimersByTimeAsync(250);
  expect(publish).toHaveBeenCalledWith({ data: Buffer.from('real frame').toString('base64'), width: 1280, height: 900 });
  await screen.stopScreen();
  await vi.advanceTimersByTimeAsync(1000);
  expect(lease.snapshot).toHaveBeenCalledTimes(2); expect(lease.dispose).toHaveBeenCalledTimes(1);
});
