import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantRulesFiles } from '@gugu/core/shared/assistantRulesFormat';
import { ExtensionsService } from './extensions-service';
import { fixtureBundle, installBundle, OFFICIAL_SOURCE } from '../../../../../../../tests/unit/desktop/assistantRules/fixtureApp';
import { NEUTRAL_ASSISTANT_RULES } from '../../../../../../../tests/unit/desktop/assistantRules/neutralRules';
import { signTestRelease } from './test-support/signed-release';

// #1931 R7 With no rules here, what the windows are told: the assistant waits for its rules (its entry shows it preparing)
// while this machine needs it and has none; that is stuck once getting them truly failed. And the copy a release carries
// starts the last good copy, so an upgrade made offline still has rules.
const state = vi.hoisted(() => ({ service: null as unknown, userData: '', appPath: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => state.appPath } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));
vi.mock('../../../../lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
// The process resolver trusts the release keys the build ships (#1931); here the build ships a key made in this test.
const releaseKey = vi.hoisted(() => {
  const { generateKeyPairSync } = process.getBuiltinModule('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { id: 'gugu-assistant-test', privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
});
vi.mock('./release/release-keys.json', () => ({
  default: { schemaVersion: 1, keys: [{ id: releaseKey.id, appId: 'gugu-assistant', sourceRepo: 'GUYI-AI/gugu-assistant', publicKey: releaseKey.publicKey }] },
}));

let work: string;
let service: ExtensionsService;
const env = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  work = mkdtempSync(path.join(tmpdir(), 'gugu-assistant-rules-state-'));
  state.userData = path.join(work, 'userData');
  state.appPath = path.join(work, 'app');
  service = new ExtensionsService(path.join(state.userData, 'task-extensions'));
  state.service = service;
  process.env.GUGU_HOME = path.join(work, 'gugu-home');
  delete process.env.GUGU_CLOUD_COMPUTER;
  delete process.env.GUGU_ASSISTANT_RULES_SEED_DIR;
});
afterEach(() => {
  process.env = { ...env };
  rmSync(work, { recursive: true, force: true });
});

async function root() {
  const module = await import('../../../../assistant-rules-root');
  const resolver = await import('../../../../assistant-rules-resolver');
  module.installProcessAssistantRules();
  const told: Array<{ pending: boolean; stuck: boolean }> = [];
  module.onAssistantRulesState(next => told.push(next));
  return { ...module, ...resolver, told };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('whether the assistant here waits for its rules', () => {
  it('waits while it lives here with none, and stops waiting — every window told — once the App is in', async () => {
    mkdirSync(path.join(process.env.GUGU_HOME!, 'assistant'), { recursive: true });
    const { assistantRulesState, assistantRules, told } = await root();
    expect(await assistantRulesState()).toEqual({ pending: true, stuck: false });
    const bundle = await fixtureBundle(path.join(work, 'bundle'), { version: '1.0.0' });
    const { proof } = signTestRelease({ appDir: bundle, appId: 'gugu-assistant', version: '1.0.0', zip: new Uint8Array(), key: releaseKey });
    installBundle(service, bundle, 'market', { ...OFFICIAL_SOURCE('1.0.0'), release: proof });
    expect((await assistantRules().refresh()).source).toBe('app');
    await settle();
    expect(await assistantRulesState()).toEqual({ pending: false, stuck: false });
    expect(told.at(-1)).toEqual({ pending: false, stuck: false });
  });

  it('never waits on a machine the assistant does not live on (and whose setup did not start)', async () => {
    const { assistantRulesState } = await root();
    expect(await assistantRulesState()).toEqual({ pending: false, stuck: false });
  });

  it('is stuck at once when an App gugu does not put over holds the id and gives no rules', async () => {
    process.env.GUGU_CLOUD_COMPUTER = '1';
    installBundle(service, await fixtureBundle(path.join(work, 'mine')), 'folder');
    const { assistantRulesState, ensureAssistantApp, told } = await root();
    expect(await ensureAssistantApp('start')).toBe('present');
    await settle();
    expect(await assistantRulesState()).toEqual({ pending: true, stuck: true });
    expect(told).toContainEqual({ pending: true, stuck: true });
  });
});

describe('the copy of the rules a release carries', () => {
  function seed(dir: string, files = assistantRulesFiles(NEUTRAL_ASSISTANT_RULES)) {
    mkdirSync(path.join(dir, 'rules'), { recursive: true });
    writeFileSync(path.join(dir, 'seed.json'), JSON.stringify({ app: 'gugu-assistant', version: '1.2.3', sha256: 'c'.repeat(64) }));
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, 'rules', name), content);
  }

  it('starts the last good copy when there is none, and is not needed again after', async () => {
    seed(path.join(state.appPath, 'assistant-rules-seed'));
    const { assistantRules } = await root();
    expect(await assistantRules().refresh()).toMatchObject({ source: 'last-good', appVersion: '1.2.3', rules: NEUTRAL_ASSISTANT_RULES });
    // A later start of a build without it still has the kept copy.
    rmSync(path.join(state.appPath, 'assistant-rules-seed'), { recursive: true });
    vi.resetModules();
    const next = await root();
    expect(await next.assistantRules().refresh()).toMatchObject({ source: 'last-good', appVersion: '1.2.3' });
  });

  it('is read through the same validator: none packaged is none, a broken one is refused', async () => {
    const { readAssistantRulesSeed } = await import('../../../../assistant-rules-root');
    expect(await readAssistantRulesSeed(path.join(work, 'absent'))).toBeNull();
    const broken = path.join(work, 'broken');
    seed(broken, { ...assistantRulesFiles(NEUTRAL_ASSISTANT_RULES), 'recovery.md': 'a\r\nb\n' });
    await expect(readAssistantRulesSeed(broken)).rejects.toMatchObject({ name: 'AssistantRulesError', file: 'recovery.md' });
  });
});
