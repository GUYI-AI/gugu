import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_CLAUDE_MODEL_POLICY } from '@gugu/session-core/models/claude-model-policy';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log }));

import { managedClaudeModelPolicy, managedPolicyOf, readManagedClaudeSettings } from './claude-managed-settings';

const CACHE = Symbol.for('gugu.claude.managedModelPolicy');
const worker = fileURLToPath(new URL('./claude-managed-settings-worker.ts', import.meta.url));
const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
let dir: string;

beforeEach(async () => {
  delete (globalThis as { [CACHE]?: unknown })[CACHE];
  log.info.mockClear();
  log.warn.mockClear();
  dir = await mkdtemp(join(tmpdir(), 'gugu-managed-claude-'));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the managed policy as the review rule reads it', () => {
  it('takes the three keys', () => {
    expect(managedPolicyOf({ availableModels: ['haiku', 3], deniedModels: ['claude-haiku-4-5'], availableModelsMatch: 'exact' }))
      .toEqual({ available: ['haiku'], denied: ['claude-haiku-4-5'], exact: true });
    expect(managedPolicyOf({})).toEqual(NO_CLAUDE_MODEL_POLICY);
    expect(managedPolicyOf(undefined)).toEqual(NO_CLAUDE_MODEL_POLICY);
  });
  it('enforces an invalid list as an empty one and an invalid match as exact, as the CLI does', () => {
    expect(managedPolicyOf({ availableModels: 'haiku', availableModelsMatch: 'strict' })).toEqual({ available: [], denied: [], exact: true });
    expect(managedPolicyOf({ availableModelsMatch: 'prefix' }).exact).toBe(false);
  });
});

describe('reading it once', () => {
  it('reads once per Claude config root and keeps the answer until the app exits', async () => {
    const read = vi.fn(async () => ({ availableModels: ['haiku'] }));
    await expect(managedClaudeModelPolicy({ HOME: '/home/a' }, read)).resolves.toEqual({ available: ['haiku'], denied: [], exact: false });
    await managedClaudeModelPolicy({ HOME: '/home/a' }, read);
    await managedClaudeModelPolicy({ HOME: '/home/a', CLAUDE_CONFIG_DIR: '/home/a/.claude' }, read);
    expect(read).toHaveBeenCalledTimes(1);
    await managedClaudeModelPolicy({ HOME: '/home/a', CLAUDE_CONFIG_DIR: '/elsewhere' }, read);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('shares one read among decisions made at the same time', async () => {
    let answer!: (value: unknown) => void;
    const read = vi.fn(() => new Promise<unknown>((resolve) => { answer = resolve; }));
    const both = Promise.all([managedClaudeModelPolicy({ HOME: '/h' }, read), managedClaudeModelPolicy({ HOME: '/h' }, read)]);
    answer({ deniedModels: ['haiku'] });
    expect(await both).toEqual([{ available: null, denied: ['haiku'], exact: false }, { available: null, denied: ['haiku'], exact: false }]);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('takes a read that fails as no managed policy, never as "blocked", and logs it', async () => {
    const read = vi.fn(async () => { throw new Error('no answer within 5000 ms'); });
    await expect(managedClaudeModelPolicy({ HOME: '/h' }, read)).resolves.toEqual(NO_CLAUDE_MODEL_POLICY);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'), expect.objectContaining({ error: 'no answer within 5000 ms' }));
  });
});

describe('the reading process', () => {
  it('answers through the real worker and the SDK the app ships', async () => {
    const reply = await readManagedClaudeSettings({ HOME: dir }, { worker, sdkEntry: async () => sdk });
    // What the policy is depends on the machine (a CI host may carry one); that it answers in this shape does not.
    expect(Object.keys(reply as object).every((key) => ['availableModels', 'deniedModels', 'availableModelsMatch'].includes(key))).toBe(true);
  }, 20_000);
  it('gives up on a process that does not answer in time', async () => {
    const silent = join(dir, 'silent.mjs');
    await writeFile(silent, 'process.on("message", () => {}); setInterval(() => {}, 1000);\n');
    await expect(readManagedClaudeSettings({ HOME: dir }, { worker: silent, sdkEntry: async () => sdk, timeoutMs: 300 }))
      .rejects.toThrow('no answer within 300 ms');
  });
  it('reports why a process failed', async () => {
    await expect(readManagedClaudeSettings({ HOME: dir }, { worker, sdkEntry: async () => join(dir, 'missing-sdk.mjs') }))
      .rejects.toThrow(/exited with 1:[\s\S]*missing-sdk/);
  });
  it('starts nothing when the reading process is not built', async () => {
    await expect(readManagedClaudeSettings({ HOME: dir }, { worker: join(dir, 'absent.js'), sdkEntry: async () => sdk }))
      .rejects.toThrow('not built');
  });
});
