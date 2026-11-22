import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskPageScreenTarget } from '../../../../server/server-task-browser';
import { connectTaskPageScreen } from './task-page-screen';
import { controlRemoteTaskPage, showWatchedBrowserContextMenu, unwatchRemoteTaskPage, watchTaskPageConnection } from './remote-task-page';

vi.mock('../extensions/projection-remote-viewer', () => ({ watchRemoteProjection: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const watchId = 'standalone-reconnect-watch';
const otherWatch = 'standalone-other-watch';
afterEach(() => { unwatchRemoteTaskPage(watchId); unwatchRemoteTaskPage(otherWatch); });

function fakePage() {
  const emitter = new EventEmitter();
  const page: TaskPageScreenTarget = {
    startScreen: vi.fn(async () => {}), stopScreen: vi.fn(async () => {}),
    input: vi.fn(async () => {}), control: vi.fn(async () => {}), isDestroyed: () => false,
    state: () => ({ url: 'http://localhost/account', title: 'Cookie fixture', isLoading: false, canGoBack: false, canGoForward: false }),
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    once: (event, listener) => emitter.once(event, listener),
  };
  return page;
}

it('closes the previous local screen viewer before reconnecting the same watch', async () => {
  const page = fakePage();
  const connect = () => connectTaskPageScreen('standalone:reconnect-tab', async () => page, () => {});
  await watchTaskPageConnection(watchId, connect);
  // A projection reset reuses its watch id while the last viewer's close drops its source.
  await expect(watchTaskPageConnection(watchId, connect)).resolves.toEqual({ success: true });
  expect(page.startScreen).toHaveBeenCalledTimes(2);
});

it('serializes overlapping resets without reviving a closed screen', async () => {
  const page = fakePage();
  const connect = () => connectTaskPageScreen('standalone:overlapping-reset-tab', async () => page, () => {});
  await watchTaskPageConnection(watchId, connect);
  await expect(Promise.all([
    watchTaskPageConnection(watchId, connect), watchTaskPageConnection(watchId, connect),
  ])).resolves.toEqual([{ success: true }, { success: true }]);
  await controlRemoteTaskPage({ watchId, control: { action: 'reload' } });
  expect(page.control).toHaveBeenCalledWith({ action: 'reload' });
  expect(page.startScreen).toHaveBeenCalledTimes(3);
});

it('reconnects after a failed pending watch without hiding the original failure', async () => {
  let reject!: (reason: unknown) => void;
  const pending = new Promise<never>((_resolve, no) => { reject = no; });
  const first = watchTaskPageConnection(watchId, () => pending);
  const page = fakePage();
  const connect = vi.fn(() => connectTaskPageScreen('standalone:failed-reset-tab', async () => page, () => {}));
  const next = watchTaskPageConnection(watchId, connect);
  expect(connect).not.toHaveBeenCalled();
  const failure = new Error('The page closed during startup');
  const rejected = expect(first).rejects.toBe(failure);
  reject(failure);
  await rejected;
  await expect(next).resolves.toEqual({ success: true });
  expect(connect).toHaveBeenCalledOnce();
});

it('leaves another viewer of the same page connected during a reset', async () => {
  const page = fakePage();
  const packets: unknown[] = [];
  const connect = () => connectTaskPageScreen('standalone:shared-reset-tab', async () => page, () => {});
  await watchTaskPageConnection(watchId, connect);
  await watchTaskPageConnection(otherWatch, () => connectTaskPageScreen('standalone:shared-reset-tab', async () => page, packet => packets.push(packet)));
  await watchTaskPageConnection(watchId, connect);
  expect(packets).not.toContainEqual(expect.objectContaining({ type: 'state', state: 'closed' }));
  await controlRemoteTaskPage({ watchId: otherWatch, control: { action: 'back' } });
  expect(page.control).toHaveBeenCalledWith({ action: 'back' });
  expect(page.stopScreen).not.toHaveBeenCalled();
});

it('does not create a new viewer when closing the previous one fails', async () => {
  const failure = new Error('The previous viewer could not release its input');
  await watchTaskPageConnection(watchId, async () => ({
    receive: async () => {}, control: async () => {}, close: () => { throw failure; },
  }));
  const connect = vi.fn();
  await expect(watchTaskPageConnection(watchId, connect)).rejects.toBe(failure);
  expect(connect).not.toHaveBeenCalled();
});

it('waits for the old local capture to stop before starting the replacement on input blur', async () => {
  const page = fakePage();
  const order: string[] = [];
  let paint: (() => void) | undefined;
  let finishStop!: () => void;
  let enteredStop!: () => void;
  const stopEntered = new Promise<void>(resolve => { enteredStop = resolve; });
  const stopBarrier = new Promise<void>(resolve => { finishStop = resolve; });
  page.startScreen = vi.fn(async publish => {
    const label = order.includes('start:first') ? 'next' : 'first';
    order.push('start:' + label);
    paint = () => publish({ data: 'aGVsbG8=', width: 360, height: 795 });
  });
  page.stopScreen = vi.fn(async () => {
    order.push('stop:pending');
    enteredStop();
    await stopBarrier;
    paint = undefined;
    order.push('stop:done');
  });
  const packets: unknown[] = [];
  const connect = () => connectTaskPageScreen('standalone:menu-blur-reset', async () => page, packet => packets.push(packet));
  await watchTaskPageConnection(watchId, connect);
  paint?.();
  expect(packets).toContainEqual(expect.objectContaining({ type: 'frame' }));
  packets.length = 0;

  const resetting = watchTaskPageConnection(watchId, connect);
  await stopEntered;
  finishStop();
  await resetting;
  paint?.();

  expect(order).toEqual(['start:first', 'stop:pending', 'stop:done', 'start:next']);
  expect(packets).toContainEqual(expect.objectContaining({ type: 'frame' }));
});

it('keeps a menu current across the same tab reset, and invalidates it on rebind or unwatch', async () => {
  const guards: Array<() => boolean> = [];
  const connect = async () => ({
    receive: async () => {}, control: async () => {}, close: () => {},
    contextMenu: async (_owner: number, _point: unknown, current: () => boolean) => { guards.push(current); return true; },
  });
  const openMenu = () => showWatchedBrowserContextMenu(12, {
    watchId, point: { x: 0.5, y: 0.5, windowX: 100, windowY: 100 },
  });
  await watchTaskPageConnection(watchId, connect, '12:first');
  expect(await openMenu()).toBe(true);
  await watchTaskPageConnection(watchId, connect, '12:first');
  expect(guards[0]?.()).toBe(true);
  await watchTaskPageConnection(watchId, connect, '12:second');
  expect(guards[0]?.()).toBe(false);
  expect(await openMenu()).toBe(true);
  unwatchRemoteTaskPage(watchId);
  await watchTaskPageConnection(watchId, connect, '12:second');
  expect(guards[1]?.()).toBe(false);
});
