import { afterEach, expect, it, vi } from 'vitest';
import { createDatabaseMaintenance, DATABASE_IDLE_MS } from './maintenance';
import { beginDatabaseMaintenance, databaseRequestsActive, noteDatabaseActivity, withDatabaseActivity } from './maintenance-activity';
import type { MaintenanceJob, MaintenanceReading } from './maintenance-worker';
import type { HostIpc, HostIpcInvokeEvent, HostIpcMain } from '../lib/host-ipc';

afterEach(() => { vi.useRealTimers(); });

const target = { path: 'main.sqlite', identity: '1:11' };
const space = { pageCount: 20_000, freelistCount: 18_000, pageSize: 4096 };
const legacy = (path: string): MaintenanceReading => ({ path, result: { before: space, after: space, reclaimedPages: 0, state: 'legacy' } });

it('arms no maintenance work on boot, waits for quiet, and skips an occupied host', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const idle = vi.fn(() => false), targets = vi.fn(() => [target]), run = vi.fn(async () => []);
  const maintenance = createDatabaseMaintenance({ idle, targets, run, report: vi.fn() });
  maintenance.start();
  expect(idle).not.toHaveBeenCalled();
  expect(targets).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS - 1);
  expect(idle).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).not.toHaveBeenCalled();
  idle.mockReturnValue(true);
  noteDatabaseActivity();
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS - 1);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledOnce();
  await maintenance.stop();
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS * 2);
  expect(run).toHaveBeenCalledOnce();
});

it('cancels synchronously, drains before request/event admission, and retains listener removal', async () => {
  const handlers = new Map<string, Parameters<HostIpcMain['handle']>[1]>();
  const listeners = new Map<string, Parameters<HostIpcMain['on']>[1]>();
  const host: HostIpc = {
    ipcMain: {
      handle: (channel, listener) => { handlers.set(channel, listener); },
      removeHandler: channel => { handlers.delete(channel); },
      on: (channel, listener) => { listeners.set(channel, listener); },
      removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); },
    },
    broadcast() {}, createMessageChannel: vi.fn(),
  };
  const wrapped = withDatabaseActivity(host), control = beginDatabaseMaintenance();
  const flag = new Int32Array(control.buffer);
  const listener = vi.fn(() => { expect(Atomics.load(flag, 0)).toBe(1); return 'admitted'; });
  wrapped.ipcMain.handle('request', listener);
  const response = handlers.get('request')!({} as HostIpcInvokeEvent);
  expect(Atomics.load(flag, 0)).toBe(1);
  expect(listener).not.toHaveBeenCalled();
  control.release();
  await expect(response).resolves.toBe('admitted');
  const second = beginDatabaseMaintenance();
  wrapped.ipcMain.on('event', listener);
  listeners.get('event')!({} as HostIpcInvokeEvent);
  expect(Atomics.load(new Int32Array(second.buffer), 0)).toBe(1);
  expect(listener).toHaveBeenCalledOnce();
  second.release();
  await new Promise<void>(resolve => queueMicrotask(resolve));
  expect(listener).toHaveBeenCalledTimes(2);
  wrapped.ipcMain.removeListener('event', listener);
  expect(listeners.size).toBe(0);
  wrapped.ipcMain.removeHandler('request');
  expect(handlers.size).toBe(0);
});

it('stop cancels and drains an in-flight worker before database teardown', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let complete!: (value: []) => void;
  let flag!: Int32Array;
  const run = vi.fn((job: MaintenanceJob) => {
    flag = new Int32Array(job.cancellation);
    return new Promise<[]>((resolve) => { complete = resolve; });
  });
  const maintenance = createDatabaseMaintenance({ idle: () => true, targets: () => [target], run, report() {} });
  maintenance.start();
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS);
  const stopped = vi.fn();
  const draining = maintenance.stop().then(stopped);
  expect(Atomics.load(flag, 0)).toBe(1);
  expect(stopped).not.toHaveBeenCalled();
  complete([]);
  await draining;
  expect(stopped).toHaveBeenCalledOnce();
});

it('continues a reclaim queue in small idle slices rather than waiting a minute per batch', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const space = { pageCount: 20_000, freelistCount: 18_000, pageSize: 4096 };
  const run = vi.fn<NonNullable<Parameters<typeof createDatabaseMaintenance>[0]['run']>>()
    .mockResolvedValueOnce([{ path: 'main.sqlite', result: { before: space, after: space, reclaimedPages: 128, state: 'reclaimed' } }])
    .mockResolvedValue([]);
  const maintenance = createDatabaseMaintenance({ idle: () => true, targets: () => [target], run, report() {} });
  maintenance.start();
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS);
  expect(run).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(999);
  expect(run).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  await maintenance.stop();
});

it('keeps pending requests busy but allows a desktop idle policy between completed background polls', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let handler!: Parameters<HostIpcMain['handle']>[1];
  const host: HostIpc = {
    ipcMain: { handle: (_channel, listener) => { handler = listener; }, removeHandler() {}, on() {}, removeListener() {} },
    broadcast() {}, createMessageChannel: vi.fn(),
  };
  let complete!: () => void;
  withDatabaseActivity(host).ipcMain.handle('poll', () => new Promise<void>(resolve => { complete = resolve; }));
  const run = vi.fn(async () => []);
  const maintenance = createDatabaseMaintenance({ idle: () => true, quiet: () => !databaseRequestsActive(), targets: () => [target], run, report() {} });
  maintenance.start();
  const response = handler({} as HostIpcInvokeEvent);
  expect(databaseRequestsActive()).toBe(true);
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS);
  expect(run).not.toHaveBeenCalled();
  complete();
  await response;
  expect(databaseRequestsActive()).toBe(false);
  // A completed background poll just before the next tick cannot starve it.
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS - 1);
  noteDatabaseActivity();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledOnce();
  await maintenance.stop();
});

it('omits legacy identities after one probe and rechecks a replacement at the same path', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let identity = target.identity;
  const run = vi.fn(async (_job: MaintenanceJob) => [legacy(target.path)]);
  const maintenance = createDatabaseMaintenance({
    idle: () => true, quiet: () => true,
    targets: () => [{ ...target, identity }], run, report() {},
  });
  maintenance.start();
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS * 5);
  expect(run).toHaveBeenCalledOnce();
  // Cached-only cycles must not install a barrier that would defer this request.
  expect(noteDatabaseActivity()).toBeUndefined();
  identity = '1:12';
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1][0].targets).toEqual([{ ...target, identity }]);
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS * 3);
  expect(run).toHaveBeenCalledTimes(2);
  await maintenance.stop();
});

it('keeps incremental targets scheduled after caching a legacy sibling', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const index = { path: 'search.sqlite', identity: '1:22' };
  const run = vi.fn(async (job: MaintenanceJob) => job.targets.map(entry => entry.path === target.path
    ? legacy(entry.path)
    : { path: entry.path, result: { before: space, after: space, reclaimedPages: 0, state: 'below-threshold' as const } }));
  const maintenance = createDatabaseMaintenance({ idle: () => true, quiet: () => true, targets: () => [target, index], run, report() {} });
  maintenance.start();
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS * 4);
  expect(run).toHaveBeenCalledTimes(4);
  expect(run.mock.calls[0][0].targets).toEqual([target, index]);
  for (const [job] of run.mock.calls.slice(1)) expect(job.targets).toEqual([index]);
  await maintenance.stop();
});

it.each(['busy', 'cancelled', 'below-threshold', 'error'] as const)('does not cache %s readings as legacy', async state => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const run = vi.fn(async (): Promise<MaintenanceReading[]> => [state === 'error'
    ? { path: target.path, error: 'probe failed' }
    : { path: target.path, result: { before: space, after: space, reclaimedPages: 0, state } }]);
  const maintenance = createDatabaseMaintenance({ idle: () => true, quiet: () => true, targets: () => [target], run, report() {} });
  maintenance.start();
  await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS * 2);
  expect(run).toHaveBeenCalledTimes(2);
  await maintenance.stop();
});
