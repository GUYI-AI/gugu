import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUGU_APPS_REPO, type MarketCodeSource, type MarketIndexVersion } from '@shared/extensions/market';
import { ExtensionsService } from './extensions-service';
import { packExtensionArchive } from './extension-archive';
import { CloudExtensionMarket, type BundleDownloadOptions, type MarketBackend } from './market-catalog';
import type { ReleaseTrustTable } from './release/market-release';
import { signTestRelease, testTrust } from './test-support/signed-release';
import { FIXTURE_RELEASE_KEY, FIXTURE_TRUST, fixtureBundle, installBundle } from '../../../../../../../tests/unit/desktop/assistantRules/fixtureApp';

// #1931 The product's assistant App goes in where the assistant needs it, without the person doing anything: a profile
// the first-run set no longer runs for gets it at start, from a local market fixture here (the App is not on the live
// market yet). Nothing is asked, nothing is shown; failures are retried with backoff.
const state = vi.hoisted(() => ({ service: null as unknown, userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));

const { installExtensionFromMarket } = await import('./extension-market-install');
const { assistantAppEnsurer, ASSISTANT_APP_ENSURE_BACKOFF_MS, personsOwnAssistantApp } = await import('../../../../assistant-app-ensure');
const { createAssistantRulesResolver } = await import('../../../../assistant-rules-resolver');
const { assistantRulesLastGoodStore } = await import('../../../../assistant-rules-last-good');
const { installedAssistantAppHere, installedAssistantRulesProvider } = await import('../../../../assistant-rules-trust');
const { events } = await import('@main/lib/events');
vi.spyOn(events, 'emit').mockImplementation(() => undefined as never);

const OFFICIAL: MarketCodeSource = { repo: GUGU_APPS_REPO, path: 'releases/gugu-assistant/1.0.0', commit: 'a'.repeat(40) };
let work: string;
let service: ExtensionsService;
/** For a step that must not retry: a retry fails the test at once (it would otherwise retry for good). */
const noRetry = () => { throw new Error('the step tried again'); };

/** A download site serving one index and its bundles; `down` makes every read fail (offline, or the App not published yet). */
class Site implements MarketBackend {
  down = false;
  /** The bundles fetched, in order. */
  fetched: string[] = [];
  constructor(public index: { apps: unknown[] }, private readonly bundles: Record<string, Uint8Array>) {}
  readText(relativePath: string): Promise<string> {
    if (this.down) return Promise.reject(new Error('market: offline'));
    return relativePath === 'index.json' ? Promise.resolve(JSON.stringify(this.index)) : Promise.reject(new Error(`HTTP 404 ${relativePath}`));
  }
  download(relativePath: string, options: BundleDownloadOptions): Promise<Uint8Array> {
    const bytes = this.bundles[relativePath];
    if (this.down || !bytes) return Promise.reject(new Error(`HTTP 404 ${relativePath}`));
    if (relativePath.startsWith('bundles/')) this.fetched.push(relativePath);
    options.onProgress?.(bytes.byteLength);
    return Promise.resolve(bytes);
  }
  urlOf(relativePath: string): string {
    return `https://download.test/market/${relativePath}`;
  }
}

/**
 * The assistant App on a local market as its signed release (#1931, signed with the tests' key), its code recorded at
 * `source`; the market trusts the tests' key, or with `trust: null` the shipped table (its slot still empty).
 */
async function market(source: MarketCodeSource = OFFICIAL, trust: ReleaseTrustTable | null = testTrust(FIXTURE_RELEASE_KEY, ['gugu-assistant'])) {
  const dir = await fixtureBundle(path.join(work, 'src', 'gugu-assistant'), { version: '1.0.0' });
  const { bytes, sha256 } = await packExtensionArchive(service, dir);
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(dir, 'manifest.json'), 'utf8')) as { apiVersion: number };
  const signed = signTestRelease({ appDir: dir, appId: 'gugu-assistant', version: '1.0.0', zip: new Uint8Array(bytes), key: FIXTURE_RELEASE_KEY });
  const row: MarketIndexVersion = {
    version: '1.0.0', manifest, apiVersion: manifest.apiVersion, minAppVersion: '0.1.0', releaseNotes: 'The assistant.',
    publishedAt: '2026-11-11T00:00:00Z', sha256, bytes: bytes.byteLength, bundle: 'bundles/gugu-assistant/1.0.0.zip', icon: null, source, yanked: null,
    release: { keyId: FIXTURE_RELEASE_KEY.id, manifest: 'releases/gugu-assistant/1.0.0/release.json', signature: 'releases/gugu-assistant/1.0.0/release.sig' },
  };
  const site = new Site({ apps: [{ id: 'gugu-assistant', deprecated: null, versions: [row] }] }, {
    [row.bundle]: new Uint8Array(bytes), [row.release!.manifest]: signed.raw, [row.release!.signature]: signed.signature,
  });
  return {
    site,
    market: new CloudExtensionMarket(site, {
      stagingRoot: path.join(state.userData, 'extension-market', 'staging'),
      heldRoot: path.join(state.userData, 'extension-market', 'held'),
      resolveHost: async () => ({ platform: 'desktop' as const, appVersion: '0.3.3', apiVersionMin: manifest.apiVersion, apiVersionMax: manifest.apiVersion }),
      snapshotStore: { read: async () => null, write: async () => undefined },
      ...(trust ? { releaseTrust: trust } : {}),
    }),
    signed,
  };
}

/**
 * The ensure step over this machine, wired as main wires it (assistant-rules-root.ts): `home` — whether the assistant lives
 * here; `waited` runs after each wait; `trust` — the host's conditions (the tests' release key by default).
 */
function machine(market: CloudExtensionMarket, home: () => boolean, waited: (count: number) => void | Promise<void> = () => {}, trust = FIXTURE_TRUST) {
  const resolver = createAssistantRulesResolver({
    provider: () => installedAssistantRulesProvider(service),
    lastGood: assistantRulesLastGoodStore(() => path.join(work, 'last-good')),
    trust,
    warn: () => {},
  });
  const waits: number[] = [];
  const warnings: string[] = [];
  const stuck = vi.fn();
  const ensurer = assistantAppEnsurer({
    installed: () => installedAssistantAppHere(service, trust),
    needed: home,
    install: async (over) => {
      const outcome = await installExtensionFromMarket({ ref: { extensionId: 'gugu-assistant' }, consent: { kind: 'gugu', ...(over ? { over } : {}) } },
        { market, afterInstall: () => {}, notifyInstalledChanged: async () => {} });
      if (!outcome.installed) throw new Error(outcome.outcome);
    },
    afterInstall: () => resolver.refresh(),
    sleep: async (ms) => { waits.push(ms); await waited(waits.length); },
    warn: (message, detail) => warnings.push(`${message} ${String(detail.error)}`),
    info: () => {},
    stuck,
  });
  return { ensurer, resolver, waits, warnings, stuck };
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'gugu-assistant-ensure-'));
  state.userData = path.join(work, 'userData');
  service = new ExtensionsService(path.join(state.userData, 'task-extensions'));
  state.service = service;
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('the assistant App goes in where the assistant needs it', () => {
  it('an existing profile whose assistant lives here gets it at start, asking nobody, and its rules are read from it', async () => {
    const { market: m, signed } = await market();
    const { ensurer, resolver } = machine(m, () => true);
    expect(await ensurer.ensure('start')).toBe('installed');
    expect(service.origins()['gugu-assistant']).toBe('market');
    expect(service.marketSource('gugu-assistant')).toEqual({ ...OFFICIAL, release: signed.proof });
    expect(await resolver.current()).toMatchObject({ source: 'app', appVersion: '1.0.0' });
  });

  it('a profile without an assistant here does not get it at start — until its setup starts', async () => {
    const { market: m } = await market();
    const { ensurer } = machine(m, () => false);
    expect(await ensurer.ensure('start')).toBe('not-needed');
    expect(service.isInstalled('gugu-assistant')).toBe(false);
    expect(await ensurer.ensure('setup')).toBe('installed');
  });

  it('an App the person uninstalled stays out while the assistant does not live here, and goes back in while it does', async () => {
    const { market: m } = await market();
    let home = false;
    const { ensurer } = machine(m, () => home);
    await ensurer.ensure('setup');
    service.uninstall('gugu-assistant');
    const next = machine(m, () => home);
    expect(await next.ensurer.ensure('start')).toBe('not-needed');
    home = true;
    expect(await next.ensurer.ensure('start')).toBe('installed');
  });

  it('leaves an App installed here some other way (a folder) as the person put it', async () => {
    const { market: m } = await market();
    installBundle(service, await fixtureBundle(path.join(work, 'mine'), { version: '9.0.0' }), 'folder');
    const { ensurer, resolver } = machine(m, () => true, noRetry);
    expect(await ensurer.ensure('start')).toBe('own');
    expect(service.get('gugu-assistant').manifest.version).toBe('9.0.0');
    expect((await resolver.current()).source).not.toBe('app');
  });

  it('retries with backoff while the market cannot give it, says it is stuck once after the window, and goes in when it can', async () => {
    const { site, market: m } = await market();
    site.down = true;
    // Back online after the whole backoff window and two more tries.
    const { ensurer, waits, stuck, warnings } = machine(m, () => true, (count) => { if (count === ASSISTANT_APP_ENSURE_BACKOFF_MS.length + 2) site.down = false; });
    expect(await ensurer.ensure('start')).toBe('installed');
    expect(waits).toEqual([...ASSISTANT_APP_ENSURE_BACKOFF_MS, 600_000, 600_000]);
    expect(stuck).toHaveBeenCalledOnce();
    expect(warnings[0]).toMatch(/offline/);
  });

  it('never puts in an assistant App whose code is not in gugu\'s market repository', async () => {
    const { market: m } = await market({ repo: 'someone/gugu-apps', path: 'sources/gugu-assistant', commit: 'b'.repeat(40) });
    // After three refused tries, the person installs their own copy from a folder: the step stops there.
    const { ensurer, warnings } = machine(m, () => true, async (count) => {
      if (count === 3) installBundle(service, await fixtureBundle(path.join(work, 'mine')), 'folder');
      // Their copy is in now: one more try would be the step going on over it.
      if (count > 3) noRetry();
    });
    expect(await ensurer.ensure('start')).toBe('own');
    expect(warnings).toHaveLength(3);
    expect(service.origins()['gugu-assistant']).toBe('folder');
    expect(warnings[0]).toMatch(/is not gugu's own App \(its code is at someone\/gugu-apps\)/);
  });

  it('while this build trusts no key for it (the shipped slot is empty), it never goes in: retried with backoff, and no rules come from it', async () => {
    const { market: m } = await market(OFFICIAL, null);
    const { ensurer, resolver, warnings } = machine(m, () => true, async (count) => {
      if (count === 3) installBundle(service, await fixtureBundle(path.join(work, 'mine')), 'folder');
      // Their copy is in now: one more try would be the step going on over it.
      if (count > 3) noRetry();
    });
    expect(await ensurer.ensure('start')).toBe('own');
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/gugu-assistant@1\.0\.0 failed the release check: its signed release does not verify \(Release: untrusted release identity or signing key\)\. Nothing was unpacked\./);
    expect(service.origins()['gugu-assistant']).toBe('folder');
    expect((await resolver.current()).source).toBe('none');
  });
});

// D2 (verify pass 1): a profile holding an old unsigned internal build of the App, from the market, was never brought to the
// signed release the market lists — "in" was only "its id is here".
describe('a copy here the host does not trust', () => {
  const OLD: MarketCodeSource = { repo: GUGU_APPS_REPO, path: 'releases/gugu-assistant/0.1.0', commit: 'c'.repeat(40) };
  /** gugu's old internal build: from the market, gugu's repository, no signed release recorded. */
  const oldUnsignedCopy = async () => installBundle(service, await fixtureBundle(path.join(work, 'old'), { version: '0.1.0' }), 'market', OLD, { unsigned: true });

  it('gugu\'s old unsigned market copy gets the market\'s signed release over it, asking nobody, and its rules are used at once', async () => {
    const { site, market: m, signed } = await market();
    await oldUnsignedCopy();
    const { ensurer, resolver } = machine(m, () => true, noRetry);
    expect((await resolver.refresh()).source).not.toBe('app');
    expect(await ensurer.ensure('start')).toBe('installed');
    expect(service.get('gugu-assistant').manifest.version).toBe('1.0.0');
    expect(service.marketSource('gugu-assistant')).toEqual({ ...OFFICIAL, release: signed.proof });
    expect(await resolver.current()).toMatchObject({ source: 'app', appVersion: '1.0.0' });
    // In now: nothing more to do, nothing fetched again.
    expect(await ensurer.ensure('assistant')).toBe('present');
    expect(site.fetched).toHaveLength(1);
  });

  it('like a missing App, only where it is needed', async () => {
    const { site, market: m } = await market();
    await oldUnsignedCopy();
    const { ensurer } = machine(m, () => false, noRetry);
    expect(await ensurer.ensure('start')).toBe('not-needed');
    expect(service.get('gugu-assistant').manifest.version).toBe('0.1.0');
    expect(site.fetched).toEqual([]);
  });

  it('the person\'s own copy is never put over: switched off, or a fork of it switched on', async () => {
    const { site, market: m } = await market();
    await oldUnsignedCopy();
    service.setEnabled('gugu-assistant', false);
    expect(await machine(m, () => true, noRetry).ensurer.ensure('start')).toBe('own');
    expect(service.get('gugu-assistant').manifest.version).toBe('0.1.0');
    service.setEnabled('gugu-assistant', true);
    const fork = await fixtureBundle(path.join(work, 'fork'), { version: '0.1.1' });
    service.retainUpstream('gugu-assistant', { name: 'upstream', base: '0.1.0', commit: OLD.commit, repo: OLD.repo, path: OLD.path, dir: null, sha256: '1'.repeat(64), bytes: 1 });
    service.installFromDirectory(fork, service.inspectDirectory(fork).manifestDigest, 'fork', { id: 'gugu' },
      { name: 'mine', base: '0.1.0', commit: OLD.commit, repo: OLD.repo, path: OLD.path, dir: fork, sha256: '1'.repeat(64), bytes: 1 });
    expect(await machine(m, () => true, noRetry).ensurer.ensure('setup')).toBe('own');
    expect(service.get('gugu-assistant').manifest.version).toBe('0.1.1');
    expect(site.fetched).toEqual([]);
  });

  it('tells the person\'s copy from gugu\'s by what the person did: where it came from, a fork switched on, switched off', () => {
    const gugus = { origin: 'market', activeVariant: 'upstream', enabled: true };
    expect(personsOwnAssistantApp(gugus)).toBeNull();
    // An install a start cut off before its record: gugu's, put in again.
    expect(personsOwnAssistantApp({ ...gugus, origin: undefined })).toBeNull();
    expect(personsOwnAssistantApp({ ...gugus, origin: 'folder' })).toMatch(/installed from folder/);
    expect(personsOwnAssistantApp({ ...gugus, origin: 'attachment' })).toMatch(/installed from attachment/);
    expect(personsOwnAssistantApp({ ...gugus, activeVariant: 'mine' })).toMatch(/fork "mine" is switched on/);
    expect(personsOwnAssistantApp({ ...gugus, enabled: false })).toMatch(/switched off/);
  });

  it('a copy it put in that the host still does not trust is not put in again in this run', async () => {
    const { site, market: m } = await market();
    await oldUnsignedCopy();
    const { ensurer } = machine(m, () => true, noRetry, [...FIXTURE_TRUST, () => 'not believed by this test']);
    expect(await ensurer.ensure('start')).toBe('installed');
    expect(await ensurer.ensure('assistant')).toBe('untrusted');
    expect(await ensurer.ensure('setup')).toBe('untrusted');
    expect(site.fetched).toHaveLength(1);
  });

  it('the market install goes over only gugu\'s copy as it was looked at, and only as a signed release', async () => {
    const { market: m } = await market();
    await oldUnsignedCopy();
    const digest = service.get('gugu-assistant').manifestDigest;
    const over = (manifestDigest: string) => installExtensionFromMarket({ ref: { extensionId: 'gugu-assistant' }, consent: { kind: 'gugu', over: { version: '0.1.0', manifestDigest } } },
      { market: m, afterInstall: () => {}, notifyInstalledChanged: async () => {} });
    await expect(installExtensionFromMarket({ ref: { extensionId: 'gugu-assistant' }, consent: { kind: 'gugu' } }, { market: m, afterInstall: () => {} }))
      .rejects.toThrow(/installed here already; it is not put in again without asking/);
    await expect(over('0'.repeat(64))).rejects.toThrow(/installed here already; it changed since it was looked at/);
    service.setEnabled('gugu-assistant', false);
    await expect(over(digest)).rejects.toThrow(/installed here already; it is switched off/);
    service.setEnabled('gugu-assistant', true);
    installBundle(service, await fixtureBundle(path.join(work, 'mine'), { version: '0.1.0' }), 'folder');
    await expect(over(service.get('gugu-assistant').manifestDigest)).rejects.toThrow(/installed here already; it is not the market's copy/);
    expect(service.origins()['gugu-assistant']).toBe('folder');
    // A market that does not require its signed release (its trust table names another App): not over a copy here.
    const unsigned = (await market(OFFICIAL, testTrust(FIXTURE_RELEASE_KEY, ['another-app']))).market;
    await oldUnsignedCopy();
    await expect(installExtensionFromMarket({ ref: { extensionId: 'gugu-assistant' }, consent: { kind: 'gugu', over: { version: '0.1.0', manifestDigest: digest } } },
      { market: unsigned, afterInstall: () => {} })).rejects.toThrow(/gugu-assistant@1\.0\.0 is not a signed release; it does not go over the copy here/);
    expect(service.get('gugu-assistant').manifest.version).toBe('0.1.0');
  });
});
