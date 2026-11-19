import { describe, it, expect, vi } from 'vitest';
import { retryCodexPreparation, parseCodexPreparation, CODEX_PREPARATION_PREFIX, CODEX_INITIALIZE_PROGRESS_MS } from '@gugu/core/local/codex-initialize.mjs';

describe('Codex native index preparation', () => {
  it('uses 120 seconds only as a progress checkpoint', () => expect(CODEX_INITIALIZE_PROGRESS_MS).toBe(120_000));
  it('publishes progress past 120 seconds without stopping or restarting a live initialize', async () => {
    vi.useFakeTimers();
    try {
      let complete!: (value: string) => void;
      const start = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
      const stop = vi.fn(async () => {}); const progress: unknown[] = [];
      const pending = retryCodexPreparation(start, { stop, onProgress: value => progress.push(value) });
      await vi.advanceTimersByTimeAsync(120_001);
      expect(start).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
      expect(progress).toHaveLength(2);
      complete('ready');
      expect(await pending).toBe('ready'); expect(progress.at(-1)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('waits and automatically starts again only for the known running backfill diagnostic', async () => {
    const start = vi.fn().mockRejectedValueOnce(Object.assign(new Error('native exited'), { stderrTail: 'timed out waiting for state db backfill (status: running)' })).mockResolvedValue('ready');
    const progress: unknown[] = []; const wait = vi.fn(async () => {});
    expect(await retryCodexPreparation(start, { wait, onProgress: p => progress.push(p) })).toBe('ready');
    expect(wait).toHaveBeenCalledTimes(1); expect(progress).toContainEqual(expect.objectContaining({ phase: 'history', attempt: 2 }));
  });
  it('does not treat an RPC timeout as permission to restart the native process', async () => {
    const start = vi.fn().mockRejectedValue(Object.assign(new Error('RPC timeout'), { code: 'codex_initialize_timeout' }));
    const stop = vi.fn(async () => {});
    await expect(retryCodexPreparation(start, { stop })).rejects.toThrow('RPC timeout');
    expect(start).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
  });
  it('keeps real failures as failures', async () => {
    const start = vi.fn().mockRejectedValue(new Error('invalid configuration'));
    await expect(retryCodexPreparation(start)).rejects.toThrow('invalid configuration'); expect(start).toHaveBeenCalledTimes(1);
  });
  it('honors cancellation between attempts', async () => {
    const controller = new AbortController();
    const start = vi.fn().mockRejectedValue(new Error('timed out waiting for state db backfill (status: running)'));
    await expect(retryCodexPreparation(start, { signal: controller.signal, wait: async () => { controller.abort(); } })).rejects.toThrow();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('only accepts structured progress with its known prefix and fields', () => {
    const value = { phase: 'history', startedAt: 100, attempt: 2 };
    expect(parseCodexPreparation(CODEX_PREPARATION_PREFIX + JSON.stringify(value))).toEqual(value);
    expect(parseCodexPreparation(CODEX_PREPARATION_PREFIX + 'null')).toBeNull();
    expect(parseCodexPreparation('unrelated stderr')).toBeUndefined();
  });
});
