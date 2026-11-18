import { decodeSessionUpdate } from '@gugu/session-core/acp';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';
import { ASSISTANT_IDLE_COMPACT_MS, CLAUDE_CACHE_IDLE_COMPACT_MS } from './idle-compaction';
import { sessionOpenMeta } from './session-manager';

afterEach(() => vi.useRealTimers());

describe('assistant maintenance host wiring', () => {
  it.each([true, false])('opts in only a prepared assistant (enabled=%s), and skips ordinary turn-end continuation', async (enabled) => {
    const h = makeAcpHarness();
    const provider = h.deps.agentHost.resolveAcp('claude')!;
    const ended = vi.fn(async () => ({ continueWith: 'must not run after maintenance' }));
    provider.behavior.onTurnEnded = ended;
    const rt = new AcpRuntime(h.deps);
    try {
      const input = makeStartInput({ sessionMeta: enabled ? { guguAssistant: { idleCompaction: true } } : undefined });
      expect((await rt.startSession(input)).success).toBe(true);
      vi.useFakeTimers();
      await h.client().sessionEvent({ sessionId: 'session-1', event: decodeSessionUpdate({
        sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact', input: null }],
      } as SessionUpdate) });
      await h.client().sessionEvent({ sessionId: 'session-1', event: decodeSessionUpdate({
        sessionUpdate: 'usage_update', used: 140_000, size: 1_000_000,
      } as SessionUpdate) });
      // The usage reading reaches the record on the next transcript tick (100 ms); the idle window starts there.
      await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS + 100);
      expect(h.agent.prompt).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(ended).not.toHaveBeenCalled();
      if (enabled) expect(JSON.stringify(h.agent.prompt.mock.calls[0])).toContain('/compact');
    } finally {
      vi.useRealTimers();
      await rt.dispose();
    }
  });

  it('does not pass host-only scheduling policy to the adapter', () => {
    expect(sessionOpenMeta(makeStartInput({ sessionMeta: {
      guguAssistant: { idleCompaction: true }, claudeCode: { options: { env: { KEEP: 'yes' } } },
    } }))).toEqual({ _meta: { claudeCode: { options: { env: { KEEP: 'yes' } } } } });
  });
});

describe('#3005 ordinary Claude Code sessions', () => {
  let dir: string;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  async function run(opts: { settings?: object; ttl: '1h' | '5m'; requestAgeMs?: number }) {
    dir = await mkdtemp(join(tmpdir(), 'gugu-3005-host-'));
    const config = join(dir, 'config');
    await mkdir(config, { recursive: true });
    if (opts.settings) await writeFile(join(config, 'settings.json'), JSON.stringify(opts.settings));
    const transcript = join(dir, 'native.jsonl');
    await writeFile(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - (opts.requestAgeMs ?? 0)).toISOString(),
      message: { model: 'claude-opus-5-5', usage: { cache_creation: {
      ephemeral_1h_input_tokens: opts.ttl === '1h' ? 4000 : 0, ephemeral_5m_input_tokens: opts.ttl === '5m' ? 4000 : 0 } } } }) + '\n');
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    const input = makeStartInput();
    input.runContext = { ...input.runContext, env: { ...input.runContext.env, CLAUDE_CONFIG_DIR: config } };
    input.cwd = join(dir, 'project');
    expect((await rt.startSession(input)).success).toBe(true);
    const client = h.client();
    const sessionId = 'session-1';
    await client.sessionEvent({ sessionId, event: decodeSessionUpdate({
      sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact', input: null }],
    } as SessionUpdate) });
    await client.sessionEvent({ sessionId, event: { kind: 'transcript_path', path: transcript } });
    // A real live turn: the prompt cache is as warm as its end.
    await rt.sendPrompt('conv-1', { text: 'long work' });
    await client.sessionEvent({ sessionId, event: decodeSessionUpdate({
      sessionUpdate: 'usage_update', used: 250_000, size: 1_000_000,
    } as SessionUpdate) });
    const before = h.agent.prompt.mock.calls.length;
    vi.useFakeTimers();
    h.agent.prompt.mockImplementation(async () => {
      await client.sessionEvent({ sessionId, event: { kind: 'compaction', compactionId: 'c1', status: 'completed', trigger: 'manual' } });
      return { stopReason: 'end_turn' };
    });
    return { h, rt, before };
  }

  it('compacts 54 minutes after the last model cycle on the one-hour cache, and marks the row as idle', async () => {
    const { h, rt, before } = await run({ ttl: '1h' });
    try {
      await vi.advanceTimersByTimeAsync(CLAUDE_CACHE_IDLE_COMPACT_MS - 60_000);
      expect(h.agent.prompt.mock.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(61_000);
      // The fire-time settings / transcript checks are real file reads.
      vi.useRealTimers();
      await vi.waitFor(() => expect(h.agent.prompt.mock.calls.length).toBe(before + 1));
      expect(JSON.stringify(h.agent.prompt.mock.calls.at(-1))).toContain('/compact');
      await vi.waitFor(() => expect(JSON.stringify(rt.getChatHistory('conv-1'))).toContain('"trigger":"idle"'));
    } finally {
      vi.useRealTimers();
      await rt.dispose();
    }
  });

  it.each([
    { name: 'idleCompaction:false', settings: { idleCompaction: false }, ttl: '1h' as const },
    { name: 'DISABLE_AUTO_COMPACT in settings env', settings: { env: { DISABLE_AUTO_COMPACT: '1' } }, ttl: '1h' as const },
    { name: 'the five-minute cache', settings: undefined, ttl: '5m' as const },
    // Turns since then only hit a usage limit: work ended, but no request refreshed the cache.
    { name: 'a cache whose last real request is past the hour', settings: undefined, ttl: '1h' as const, requestAgeMs: 2 * 60 * 60_000 },
  ])('leaves the session alone with $name', async ({ settings, ttl, requestAgeMs }) => {
    const { h, rt, before } = await run({ ...(settings ? { settings } : {}), ttl, ...(requestAgeMs ? { requestAgeMs } : {}) });
    try {
      await vi.advanceTimersByTimeAsync(CLAUDE_CACHE_IDLE_COMPACT_MS + 1_000);
      vi.useRealTimers();
      // Long enough for the fire-time file reads that would have let it through.
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(h.agent.prompt.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
      await rt.dispose();
    }
  });
});
