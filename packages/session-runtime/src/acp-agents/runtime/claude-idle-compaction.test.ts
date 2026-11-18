import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPromptCache, resolveClaudeIdleCompaction } from './claude-idle-compaction';
import { CLAUDE_CACHE_IDLE_COMPACT_MS, IdleCompaction, claudeCacheIdleCompaction } from './idle-compaction';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gugu-idle-compact-')); });
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });

const configDir = () => join(dir, 'config');
const cwd = () => join(dir, 'project');
async function settings(path: string, value: unknown) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
const resolve = (env: Record<string, string> = {}) =>
  resolveClaudeIdleCompaction({ env: { CLAUDE_CONFIG_DIR: configDir(), ...env }, cwd: cwd(), homeDir: join(dir, 'home') });

describe('#3005 Claude idle compaction settings', () => {
  it('defaults to 200k and honors CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS with its 100k floor, settings env winning', async () => {
    expect(await resolve()).toEqual({ enabled: true, minTokens: 200_000 });
    expect(await resolve({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '150000' })).toEqual({ enabled: true, minTokens: 150_000 });
    expect(await resolve({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '5000' })).toEqual({ enabled: true, minTokens: 100_000 });
    expect(await resolve({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: 'abc' })).toEqual({ enabled: true, minTokens: 200_000 });
    await settings(join(configDir(), 'settings.json'), { env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '300000' } });
    expect(await resolve({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '150000' })).toEqual({ enabled: true, minTokens: 300_000 });
  });

  it('is off for idleCompaction:false, autoCompactEnabled:false and DISABLE_AUTO_COMPACT; local beats project beats user', async () => {
    expect(await resolve({ DISABLE_AUTO_COMPACT: '1' })).toMatchObject({ enabled: false });
    expect(await resolve({ DISABLE_AUTO_COMPACT: '0' })).toMatchObject({ enabled: true });
    await settings(join(configDir(), 'settings.json'), { idleCompaction: false });
    expect(await resolve()).toEqual({ enabled: false, reason: 'idleCompaction=false' });
    await settings(join(cwd(), '.claude', 'settings.local.json'), { idleCompaction: true });
    expect(await resolve()).toMatchObject({ enabled: true });
    await settings(join(cwd(), '.claude', 'settings.json'), { autoCompactEnabled: false });
    expect(await resolve()).toEqual({ enabled: false, reason: 'autoCompactEnabled=false' });
  });

  it('reads the TTL of the last main-chain cache write; cache reads and sidechains say nothing', async () => {
    const entry = (oneHour: number, fiveMinutes: number, extra: { pad?: string; isSidechain?: boolean; timestamp?: string; model?: string } = {}) =>
      JSON.stringify({ type: 'assistant', timestamp: extra.timestamp ?? '2026-11-18T01:00:00.000Z', ...(extra.isSidechain ? { isSidechain: true } : {}),
        ...(extra.pad ? { pad: extra.pad } : {}), message: { model: extra.model ?? 'claude-opus-5-5', usage: {
          cache_read_input_tokens: oneHour || fiveMinutes ? 0 : 5000,
          cache_creation: { ephemeral_1h_input_tokens: oneHour, ephemeral_5m_input_tokens: fiveMinutes } } } });
    const ttl = async (path: string) => (await readPromptCache(path))?.ttl ?? null;
    const path = join(dir, 't.jsonl');
    await writeFile(path, [entry(0, 900), entry(1200, 0), entry(0, 0), entry(0, 50, { isSidechain: true }), '{"type":"user"}', ''].join('\n'));
    expect(await ttl(path)).toBe('1h');
    await writeFile(path, [entry(1200, 0), entry(0, 900), entry(0, 0)].join('\n'));
    expect(await ttl(path)).toBe('5m');
    await writeFile(path, entry(0, 0));
    expect(await ttl(path)).toBeNull();
    // The last request time is the newest real cache use; usage-limit notes (`<synthetic>`) never reached the model.
    await writeFile(path, [entry(1200, 0, { timestamp: '2026-11-18T01:00:00.000Z' }), entry(0, 0, { timestamp: '2026-11-18T01:20:00.000Z' }),
      entry(0, 0, { timestamp: '2026-11-18T03:00:00.000Z', model: '<synthetic>' })].join('\n'));
    expect(await readPromptCache(path)).toEqual({ ttl: '1h', lastRequestAt: Date.parse('2026-11-18T01:20:00.000Z') });
    expect(await readPromptCache(join(dir, 'missing.jsonl'))).toBeNull();
    // A long run of pure cache reads pushes the last write past the first read-back chunk (and lines across its edge).
    const reads = Array.from({ length: 6000 }, () => entry(0, 0, { pad: 'x'.repeat(700) }));
    await writeFile(path, [entry(1200, 0), ...reads, ''].join('\n'));
    expect(await ttl(path)).toBe('1h');
  });
});

describe('#3005 cache-aware scheduler', () => {
  it('fires 54 minutes after the last live model cycle, not after the session was last seen idle', async () => {
    vi.useFakeTimers();
    const policy = claudeCacheIdleCompaction();
    const compact = vi.fn(async () => undefined);
    const state = { idle: true, contextTokens: 250_000, revision: 1, lastWorkEndedAt: Date.now() as number | null };
    const scheduler = new IdleCompaction(() => state, compact, undefined, policy);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    scheduler.update();
    await vi.advanceTimersByTimeAsync(CLAUDE_CACHE_IDLE_COMPACT_MS - 10 * 60_000 - 1);
    expect(compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(compact).toHaveBeenCalledOnce();
    scheduler.close();
  });

  it('re-anchors on a later model cycle, and never compacts history it has not seen live or a cache already past its window', async () => {
    vi.useFakeTimers();
    const compact = vi.fn(async () => undefined);
    let state = { idle: true, contextTokens: 250_000, revision: 1, lastWorkEndedAt: null as number | null };
    const scheduler = new IdleCompaction(() => state, compact, undefined, claudeCacheIdleCompaction());
    scheduler.update();
    await vi.advanceTimersByTimeAsync(CLAUDE_CACHE_IDLE_COMPACT_MS * 2);
    expect(compact).not.toHaveBeenCalled();

    state = { ...state, lastWorkEndedAt: Date.now() };
    scheduler.update();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // A cycle Claude Code started itself (no new input): the cache was refreshed again.
    state = { ...state, lastWorkEndedAt: Date.now() };
    scheduler.update();
    await vi.advanceTimersByTimeAsync(CLAUDE_CACHE_IDLE_COMPACT_MS - 1);
    expect(compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(compact).toHaveBeenCalledOnce();
    scheduler.close();

    const stale = vi.fn(async () => undefined);
    const late = new IdleCompaction(() => ({ idle: true, contextTokens: 250_000, revision: 1,
      lastWorkEndedAt: Date.now() - CLAUDE_CACHE_IDLE_COMPACT_MS - 60_000 }), stale, undefined, claudeCacheIdleCompaction());
    late.update();
    await vi.advanceTimersByTimeAsync(CLAUDE_CACHE_IDLE_COMPACT_MS * 2);
    expect(stale).not.toHaveBeenCalled();
    late.close();
  });

  it('skips contexts under the threshold', async () => {
    vi.useFakeTimers();
    const compact = vi.fn(async () => undefined);
    const scheduler = new IdleCompaction(() => ({ idle: true, contextTokens: 199_999, revision: 1, lastWorkEndedAt: Date.now() }),
      compact, undefined, claudeCacheIdleCompaction());
    scheduler.update();
    await vi.advanceTimersByTimeAsync(CLAUDE_CACHE_IDLE_COMPACT_MS * 2);
    expect(compact).not.toHaveBeenCalled();
    scheduler.close();
  });
});
