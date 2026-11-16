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
const state = vi.hoisted(() => ({ service: null as unknown, userData: '', appPath: '', signedIn: null as string | null, assistants: {} as Record<string, string | null>, bindingRead: null as null | { entered: () => void; wait: Promise<void> }, accountRead: null as null | { entered: () => void; wait: Promise<string> } }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => state.appPath } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));
// The account signed in and its assistant's provision (wherever the assistant lives); no one signed in: denied.
const signedIn = () => {
  if (!state.signedIn) throw Object.assign(new Error('Not signed in'), { code: 'denied' });
  return state.signedIn;
};
vi.mock('./app-assistant-binding', () => ({ signedInAccountAssistant: async () => {
  const ownerId = signedIn();
  const bindingRead = state.bindingRead;
  bindingRead?.entered();
  if (bindingRead) await bindingRead.wait;
  return { ownerId, assistantId: state.assistants[ownerId] ?? null };
} }));
async function fixtureAccount() {
  const read = state.accountRead;
  if (read) {
    state.accountRead = null; // only the selected old read is held
    read.entered();
    return { token: 't', ownerId: await read.wait };
  }
  return { token: 't', ownerId: signedIn() };
}
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
  state.bindingRead = null;
  state.accountRead = null;
  marketInstalls.length = 0;
});
afterEach(() => {
  process.env = { ...env };
  rmSync(work, { recursive: true, force: true });
});

async function root() {
  // Manual module mocks can fall through during concurrent dynamic imports in Vitest 4.1.10.
  const unread = await import('./app-unread-bindings');
  vi.spyOn(unread, 'account').mockImplementation(fixtureAccount);
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
    // The account fact is read asynchronously; a fixed pause is not its completion signal.
    await vi.waitFor(async () => {
      expect(await assistantRulesState()).toEqual({ pending: true, stuck: false });
      expect(told.at(-1)).toEqual({ pending: true, stuck: false });
    });
    // Another account signed in now: what was read about the first one is not about it.
    state.signedIn = 'owner-2';
    expect(await assistantRulesState()).toEqual({ pending: false, stuck: false });
    void going.catch(() => undefined);
  });

  it('does not announce pending or install before the account assistant lookup resolves', async () => {
    state.signedIn = 'owner-1';
    state.assistants = { 'owner-1': 'assistant-1' };
    const entered = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<void>();
    state.bindingRead = { entered: () => entered.resolve(), wait: lookup.promise };
    const { assistantRulesState, ensureAssistantApp, told } = await root();
    const going = ensureAssistantApp('assistant');
    try {
      // Hold the real root's account lookup, independently of import speed or wall-clock time.
      await entered.promise;
      expect(await assistantRulesState()).toEqual({ pending: false, stuck: false });
      expect(told).not.toContainEqual({ pending: true, stuck: false });
      expect(marketInstalls).toEqual([]);

      lookup.resolve();
      await vi.waitFor(async () => {
        expect(await assistantRulesState()).toEqual({ pending: true, stuck: false });
        expect(told.at(-1)).toEqual({ pending: true, stuck: false });
        expect(marketInstalls).toHaveLength(1);
      });
      state.signedIn = 'owner-2';
      expect(await assistantRulesState()).toEqual({ pending: false, stuck: false });
    } finally {
      lookup.resolve();
      state.bindingRead = null;
      void going.catch(() => undefined);
    }
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


// Diagnostic candidates for #2922's notification mismatch. No larger wait or weaker original assertion.
// These cases exercise the real root, resolver and publisher. Only the account response is a controlled gate.
// A check-phase boundary drains the already-released read's Promise continuations: that read has no I/O left.
const releasedAccountReadDrained = () => new Promise<void>(resolve => setImmediate(resolve));

async function publishedAccountRoot(ownerId: string) {
  state.signedIn = ownerId;
  state.assistants[ownerId] = `assistant-${ownerId}`;
  const api = await root();
  const going = api.ensureAssistantApp('assistant');
  await vi.waitFor(async () => {
    expect(await api.assistantRulesState()).toEqual({ pending: true, stuck: false });
    expect(api.told.at(-1)).toEqual({ pending: true, stuck: false });
  });
  return { ...api, going };
}

function holdNextAccountRead() {
  const entered = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<string>();
  state.accountRead = { entered: () => entered.resolve(), wait: reply.promise };
  return { entered: entered.promise, reply };
}

describe('controlled ownership and ordering of assistant state publications', () => {
  it.each(['owner-1', 'owner-2'])('keeps the latest pending notification after an older account response for %s', async oldOwner => {
    const api = await publishedAccountRoot('owner-1');
    state.signedIn = oldOwner;
    const oldRead = holdNextAccountRead();
    api.ensureAssistantApp('assistant');
    try {
      await oldRead.entered;
      state.signedIn = 'owner-1';
      api.ensureAssistantApp('assistant'); // newer read is pending=true, including the deduplicated case
      await releasedAccountReadDrained(); // cached account module; only Promise continuations remain
      expect(await api.assistantRulesState()).toEqual({ pending: true, stuck: false });
      expect(api.told.at(-1)).toEqual({ pending: true, stuck: false });
      oldRead.reply.resolve(oldOwner);
      await releasedAccountReadDrained();
      expect(await api.assistantRulesState()).toEqual({ pending: true, stuck: false });
      expect(api.told.at(-1)).toEqual({ pending: true, stuck: false });
    } finally {
      oldRead.reply.resolve(oldOwner);
      await releasedAccountReadDrained();
      state.accountRead = null;
      void api.going.catch(() => undefined);
    }
  });

  it('keeps the newer ready notification when an older no-rules account read finishes last', async () => {
    const api = await publishedAccountRoot('owner-1');
    const oldRead = holdNextAccountRead();
    api.ensureAssistantApp('assistant'); // same running ensure; a fresh real publishState read
    try {
      await oldRead.entered; // old getter already captured NO_ASSISTANT_RULES
      installBundle(service, ...await signedBundle('1.0.0'));
      await vi.waitFor(async () => {
        expect((await api.assistantRules().current()).source).toBe('app');
        expect(await api.assistantRulesState()).toEqual({ pending: false, stuck: false });
        expect(api.told.at(-1)).toEqual({ pending: false, stuck: false });
      });
      oldRead.reply.resolve('owner-1');
      await releasedAccountReadDrained();
      expect(await api.assistantRulesState()).toEqual({ pending: false, stuck: false });
      expect(api.told.at(-1)).toEqual({ pending: false, stuck: false });
    } finally {
      oldRead.reply.resolve('owner-1');
      await releasedAccountReadDrained();
      state.accountRead = null;
      void api.going.catch(() => undefined);
    }
  });

  it('does not send an old module instance publication to a fresh instance listener', async () => {
    const first = await publishedAccountRoot('owner-1');
    const oldRead = holdNextAccountRead();
    first.ensureAssistantApp('assistant');
    try {
      await oldRead.entered;
      vi.resetModules();
      const next = await publishedAccountRoot('owner-1');
      expect(next.assistantRulesState).not.toBe(first.assistantRulesState);
      expect(next.assistantRules).not.toBe(first.assistantRules);
      const notifications = [...next.told];
      oldRead.reply.resolve('owner-2'); // old instance's account check now refuses its cached owner
      await releasedAccountReadDrained();
      expect(first.told.at(-1)).toEqual({ pending: false, stuck: false });
      expect(next.told).toEqual(notifications);
      expect(await next.assistantRulesState()).toEqual({ pending: true, stuck: false });
      expect(next.told.at(-1)).toEqual({ pending: true, stuck: false });
      void next.going.catch(() => undefined);
    } finally {
      oldRead.reply.resolve('owner-2');
      await releasedAccountReadDrained();
      state.accountRead = null;
      void first.going.catch(() => undefined);
    }
  });

  it('keeps a next fixture separate when the previous fixture still owns a late account read', async () => {
    const first = await publishedAccountRoot('owner-1');
    const oldRead = holdNextAccountRead();
    first.ensureAssistantApp('assistant');
    const nextWork = mkdtempSync(path.join(tmpdir(), 'gugu-assistant-next-fixture-'));
    try {
      await oldRead.entered;
      // Mimic the existing afterEach/beforeEach mutable boundary without hiding the old task.
      state.userData = path.join(nextWork, 'userData');
      state.appPath = path.join(nextWork, 'app');
      service = new ExtensionsService(path.join(state.userData, 'task-extensions'));
      state.service = service;
      process.env.GUGU_HOME = path.join(nextWork, 'gugu-home');
      state.assistants = {};
      vi.resetModules();
      const next = await publishedAccountRoot('owner-2');
      expect(next.assistantRulesState).not.toBe(first.assistantRulesState);
      const notifications = [...next.told];
      oldRead.reply.resolve('owner-2');
      await releasedAccountReadDrained();
      expect(first.told.at(-1)).toEqual({ pending: false, stuck: false });
      expect(next.told).toEqual(notifications);
      expect(await next.assistantRulesState()).toEqual({ pending: true, stuck: false });
      expect(next.told.at(-1)).toEqual({ pending: true, stuck: false });
      void next.going.catch(() => undefined);
    } finally {
      oldRead.reply.resolve('owner-2');
      await releasedAccountReadDrained();
      state.accountRead = null;
      void first.going.catch(() => undefined);
      rmSync(nextWork, { recursive: true, force: true });
    }
  });
});
