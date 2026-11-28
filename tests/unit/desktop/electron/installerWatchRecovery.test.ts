import { afterEach, expect, it, vi } from 'vitest';
import { execWithStallWatch, STALL_KILL_ESCALATE_MS, type StallWatchDeps } from '../../../../apps/desktop/electron/engine-downloader';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('a rejected progress sample is observed and the watchdog keeps polling', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let exit!: (error: Error | null, stdout: string) => void;
  const kill = vi.fn();
  const read = vi.fn(async () => 0).mockRejectedValueOnce(new Error('scan failed'));
  const deps: StallWatchDeps = { spawn: (_cmd, _args, _env, done) => { exit = done; return { pid: 1, hasExited: () => false, killTree: kill }; }, readProgressBytes: read };
  const pending = execWithStallWatch('npm', [], { env: {} }, '/progress', { deps, stallTimeoutMs: 200, pollIntervalMs: 100 });
  const result = pending.catch(error => error);
  await vi.advanceTimersByTimeAsync(500);
  const calls = read.mock.calls.length;
  exit(new Error('terminated'), '');
  await result;
  expect(calls).toBeGreaterThan(1);
  expect(kill).toHaveBeenCalledWith('SIGTERM');
  expect(console.warn).toHaveBeenCalled();
});

it('synchronous spawn completion settles without leaving a timer', async () => {
  vi.useFakeTimers();
  const deps: StallWatchDeps = { spawn: (_cmd, _args, _env, done) => { done(null, 'done'); return { pid: undefined, hasExited: () => true, killTree: vi.fn() }; }, readProgressBytes: async () => 0 };
  await expect(execWithStallWatch('npm', [], { env: {} }, '/progress', { deps })).resolves.toBe('done');
  expect(vi.getTimerCount()).toBe(0);
});

it('repeated sample failures do not disable stall detection or flood warnings', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let exit!: (error: Error | null, stdout: string) => void;
  const kill = vi.fn();
  const deps: StallWatchDeps = { spawn: (_cmd, _args, _env, done) => { exit = done; return { pid: 1, hasExited: () => false, killTree: kill }; }, readProgressBytes: async () => { throw new Error('unreadable'); } };
  const result = execWithStallWatch('npm', [], { env: {} }, '/progress', { deps, stallTimeoutMs: 300, pollIntervalMs: 100 }).catch(error => error);
  await vi.advanceTimersByTimeAsync(500);
  expect(kill).toHaveBeenCalledWith('SIGTERM');
  expect(console.warn).toHaveBeenCalledOnce();
  exit(new Error('terminated'), ''); await result;
});

it('exiting after SIGTERM cancels both escalation timers', async () => {
  vi.useFakeTimers();
  let exit!: (error: Error | null, stdout: string) => void;
  const deps: StallWatchDeps = { spawn: (_cmd, _args, _env, done) => { exit = done; return { pid: 1, hasExited: () => false, killTree: vi.fn() }; }, readProgressBytes: async () => 0 };
  const pending = execWithStallWatch('npm', [], { env: {} }, '/progress', { deps, stallTimeoutMs: 100, pollIntervalMs: 100 });
  const result = pending.catch(error => error);
  await vi.advanceTimersByTimeAsync(200);
  exit(new Error('terminated'), ''); await result;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(STALL_KILL_ESCALATE_MS * 2);
});
