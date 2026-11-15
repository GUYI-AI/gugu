import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantRulesFiles } from '@gugu/core/shared/assistantRulesFormat';
import type { MarketInstallRecord } from '@shared/extensions/market';
import { ExtensionsService } from './extensions-service';
import { fixtureBundle, installBundle, OFFICIAL_SOURCE } from '../../../../../../../tests/unit/desktop/assistantRules/fixtureApp';
import { NEUTRAL_ASSISTANT_RULES } from '../../../../../../../tests/unit/desktop/assistantRules/neutralRules';
import { signTestRelease } from './test-support/signed-release';

// #1931 R7 With no rules here, what the windows are told: the assistant waits for its rules (its entry shows it preparing)
// while this machine needs it and has none; that is stuck once getting them truly failed. And the copy a release carries
// starts the last good copy, so an upgrade made offline still has rules.
const state = vi.hoisted(() => ({ service: null as unknown, userData: '', appPath: '', signedIn: null as string | null, assistants: {} as Record<string, string | null> }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => state.appPath } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));
// The account signed in and its assistant's provision (wherever the assistant lives); no one signed in: denied.
const signedIn = () => {
  if (!state.signedIn) throw Object.assign(new Error('Not signed in'), { code: 'denied' });
  return state.signedIn;
};
vi.mock('./app-assistant-binding', () => ({ signedInAccountAssistant: async () => ({ ownerId: signedIn(), assistantId: state.assistants[signedIn()] ?? null }) }));
vi.mock('./app-unread-bindings', () => ({ account: async () => ({ token: 't', ownerId: signedIn() }) }));
// A market install never finishes here (no network in tests): the App stays not in while it goes. What it was asked is kept.
const marketInstalls = vi.hoisted(() => [] as unknown[]);
vi.mock('./extension-market-install', () => ({ installExtensionFromMarket: (install: unknown) => { marketInstalls.push(install); return new Promise(() => undefined); } }));
vi.mock('../../../../lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
// The process resolver trusts the release keys the build ships (#1931); here the build ships a key made in this test.
const releaseKey = vi.hoisted(() => {
  const { generateKeyPairSync } = process.getBuiltinModule('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { id: 'gugu-assistant-test', privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
});
vi.mock('@shared/extensions/release/release-keys.json', () => ({
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
  state.signedIn = null;
  state.assistants = {};
  marketInstalls.length = 0;
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

  it('waits, and puts the App in, while the account signed in has an assistant elsewhere: the App is its page here', async () => {
    state.signedIn = 'owner-1';
    state.assistants = { 'owner-1': 'assistant-1' };
    const { assistantRulesState, ensureAssistantApp, told } = await root();
    // Not known before main asked: a window found the assistant, the App is not in.
    const going = ensureAssistantApp('assistant');
    await settle();
    expect(await assistantRulesState()).toEqual({ pending: true, stuck: false });
    expect(told.at(-1)).toEqual({ pending: true, stuck: false });
    // Another account signed in now: what was read about the first one is not about it.
    state.signedIn = 'owner-2';
    expect(await assistantRulesState()).toEqual({ pending: false, stuck: false });
    void going.catch(() => undefined);
  });

  it('leaves a person with no assistant anywhere alone: nothing to wait for, nothing put in', async () => {
    state.signedIn = 'owner-1';
    const { assistantRulesState, ensureAssistantApp } = await root();
    expect(await ensureAssistantApp('assistant')).toBe('not-needed');
    expect(await assistantRulesState()).toEqual({ pending: false, stuck: false });
    expect(service.isInstalled('gugu-assistant')).toBe(false);
  });

  it('is stuck at once when an App gugu does not put over holds the id and gives no rules', async () => {
    process.env.GUGU_CLOUD_COMPUTER = '1';
    installBundle(service, await fixtureBundle(path.join(work, 'mine')), 'folder');
    const { assistantRulesState, ensureAssistantApp, told } = await root();
    expect(await ensureAssistantApp('start')).toBe('own');
    await settle();
    expect(await assistantRulesState()).toEqual({ pending: true, stuck: true });
    // The windows are told after a refresh that reads the disk; under a loaded run that can outlast a fixed pause.
    await vi.waitFor(() => expect(told).toContainEqual({ pending: true, stuck: true }));
    expect(marketInstalls).toEqual([]);
    // The person puts the signed release in themselves: rules, so nothing waits and nothing is stuck — the windows told at
    // once, with no restart and no session start.
    service.uninstall('gugu-assistant');
    installBundle(service, ...await signedBundle('1.0.0'));
    await vi.waitFor(() => expect(told.at(-1)).toEqual({ pending: false, stuck: false }));
  });
});

/** The assistant App's `version` from its release folder, signed with this test's key: installBundle's arguments. */
async function signedBundle(version: string): Promise<[string, 'market', MarketInstallRecord]> {
  const bundle = await fixtureBundle(path.join(work, `signed-${version}`), { version });
  const { proof } = signTestRelease({ appDir: bundle, appId: 'gugu-assistant', version, zip: new Uint8Array(), key: releaseKey });
  return [bundle, 'market', { ...OFFICIAL_SOURCE(version), release: proof }];
}

// D2 (verify pass 1) in main's own wiring: an old unsigned build of the App from the market held the id, so nothing put the
// signed release in; and a release put in by hand was used only after a restart.
describe('gugu\'s untrusted copy of the App here', () => {
  const oldUnsigned = async () => installBundle(service, await fixtureBundle(path.join(work, 'old'), { version: '0.1.0' }), 'market', OFFICIAL_SOURCE('0.1.0'), { unsigned: true });

  it('the ensure step asks the market for the release over that very copy', async () => {
    process.env.GUGU_CLOUD_COMPUTER = '1';
    await oldUnsigned();
    const { ensureAssistantApp } = await root();
    void ensureAssistantApp('start');
    await vi.waitFor(() => expect(marketInstalls).toHaveLength(1));
    expect(marketInstalls[0]).toEqual({ ref: { extensionId: 'gugu-assistant' },
      consent: { kind: 'gugu', over: { version: '0.1.0', manifestDigest: service.get('gugu-assistant').manifestDigest } } });
  });

  it('updated to the signed release, its rules are what every read answers from then on, with no restart', async () => {
    await oldUnsigned();
    const { assistantRules } = await root();
    expect((await assistantRules().refresh()).source).toBe('none');
    installBundle(service, ...await signedBundle('1.0.0'));
    await vi.waitFor(async () => expect(await assistantRules().current()).toMatchObject({ source: 'app', appVersion: '1.0.0' }));
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
