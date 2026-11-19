import { describe, it, expect, vi } from 'vitest';
import { retryCodexPreparation, parseCodexPreparation, CODEX_PREPARATION_PREFIX, CODEX_INITIALIZE_TIMEOUT, CODEX_INITIALIZE_TIMEOUT_MS } from '@gugu/core/local/codex-initialize.mjs';

describe('Codex native index preparation', () => {
  it('uses a 120 second native attempt budget', () => expect(CODEX_INITIALIZE_TIMEOUT_MS).toBe(120_000));
  it('retries an expired attempt and preserves the next attempt, without clearing persisted work', async () => {
    let watermark = 0;
    const stop = vi.fn(async () => {}); const progress: unknown[] = [];
    const result = await retryCodexPreparation(async () => { watermark++; if (watermark === 1) throw Object.assign(new Error('initialize deadline'), { code: CODEX_INITIALIZE_TIMEOUT }); return watermark; },
      { stop, wait: async () => {}, onProgress: p => progress.push(p) });
    expect(result).toBe(2); expect(stop).toHaveBeenCalledTimes(1); expect(progress.at(-1)).toBeNull();
  });
  it('waits and automatically starts again only for the known running backfill diagnostic', async () => {
    const start = vi.fn().mockRejectedValueOnce(Object.assign(new Error('native exited'), { stderrTail: 'timed out waiting for state db backfill (status: running)' })).mockResolvedValue('ready');
    const progress: unknown[] = []; const wait = vi.fn(async () => {});
    expect(await retryCodexPreparation(start, { wait, onProgress: p => progress.push(p) })).toBe('ready');
    expect(wait).toHaveBeenCalledTimes(1); expect(progress).toContainEqual(expect.objectContaining({ phase: 'history', attempt: 2 }));
  });
  it('keeps real failures as failures', async () => {
    const start = vi.fn().mockRejectedValue(new Error('invalid configuration'));
    await expect(retryCodexPreparation(start)).rejects.toThrow('invalid configuration'); expect(start).toHaveBeenCalledTimes(1);
  });
  it('honors cancellation between attempts', async () => {
    const controller = new AbortController();
    const start = vi.fn().mockRejectedValue(Object.assign(new Error('deadline'), { code: CODEX_INITIALIZE_TIMEOUT }));
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
