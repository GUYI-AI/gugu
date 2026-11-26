import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_CLAUDE_MODEL_POLICY, type ClaudeModelPolicy } from '@gugu/session-core/models/claude-model-policy';

const managed = vi.hoisted(() => ({ policy: null as ClaudeModelPolicy | null }));
vi.mock('./claude-managed-settings', () => ({ managedClaudeModelPolicy: vi.fn(async () => managed.policy) }));

import { claudeReviewModelPolicy, claudeScopeAllowlist } from './claude-model-policy';

let home: string;
let work: string;
const env = () => ({ HOME: home });
const put = (file: string, document: unknown) => writeFile(file, typeof document === 'string' ? document : JSON.stringify(document));
const user = (document: unknown) => put(join(home, '.claude', 'settings.json'), document);
const project = (document: unknown) => put(join(work, '.claude', 'settings.json'), document);
const local = (document: unknown) => put(join(work, '.claude', 'settings.local.json'), document);

beforeEach(async () => {
  managed.policy = NO_CLAUDE_MODEL_POLICY;
  home = await mkdtemp(join(tmpdir(), 'gugu-claude-home-'));
  work = await mkdtemp(join(tmpdir(), 'gugu-claude-work-'));
  await mkdir(join(home, '.claude'));
  await mkdir(join(work, '.claude'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe("the user's, the project's and the local lists", () => {
  it('are concatenated, as the CLI does', async () => {
    await user({ availableModels: ['claude-sonnet-4-6'] });
    await project({ availableModels: ['glm-5', 'claude-sonnet-4-6'] });
    await local({ availableModels: ['claude-haiku-5-5'] });
    expect(await claudeScopeAllowlist(env(), work)).toEqual(['claude-sonnet-4-6', 'glm-5', 'claude-haiku-5-5']);
  });
  it('are none when no file sets one; bad JSON and a value that is not a list do not count', async () => {
    expect(await claudeScopeAllowlist(env(), work)).toBeNull();
    await user('{"availableModels": [');
    await project({ availableModels: 'sonnet' });
    expect(await claudeScopeAllowlist(env(), work)).toBeNull();
    await local({ availableModels: [1, 'glm-5'] });
    expect(await claudeScopeAllowlist(env(), work)).toEqual(['glm-5']);
  });
  it("read the user's file under CLAUDE_CONFIG_DIR, and only it without a session folder", async () => {
    const configDir = join(home, 'elsewhere');
    await mkdir(configDir);
    await put(join(configDir, 'settings.json'), { availableModels: ['claude-opus-4-6'] });
    await user({ availableModels: ['ignored'] });
    await project({ availableModels: ['glm-5'] });
    expect(await claudeScopeAllowlist({ HOME: home, CLAUDE_CONFIG_DIR: configDir })).toEqual(['claude-opus-4-6']);
  });
});

describe('the policy a reviewer is checked against', () => {
  it('a connection session: the three lists, with the managed denials', async () => {
    managed.policy = { available: null, denied: ['claude-haiku-4-5'], exact: true };
    await project({ availableModels: ['glm-5'] });
    expect(await claudeReviewModelPolicy({ route: 'custom', env: env(), cwd: work }))
      .toEqual({ available: ['glm-5'], denied: ['claude-haiku-4-5'], exact: true });
  });
  it('a managed list replaces every other', async () => {
    managed.policy = { available: ['haiku'], denied: [], exact: false };
    await user({ availableModels: ['claude-sonnet-4-6'] });
    expect(await claudeReviewModelPolicy({ route: 'custom', env: env(), cwd: work })).toEqual(managed.policy);
  });
  it("a Gugu-model session: its own settings list the reviewer, so only the managed tier counts", async () => {
    await user({ availableModels: ['claude-opus-4-6'] });
    await project({ availableModels: ['claude-opus-4-6'] });
    expect(await claudeReviewModelPolicy({ route: 'platform', env: env(), cwd: work })).toEqual(NO_CLAUDE_MODEL_POLICY);
    managed.policy = { available: ['claude-opus-4-6'], denied: ['claude-haiku-5'], exact: false };
    expect(await claudeReviewModelPolicy({ route: 'platform', env: env(), cwd: work })).toEqual(managed.policy);
  });
});
