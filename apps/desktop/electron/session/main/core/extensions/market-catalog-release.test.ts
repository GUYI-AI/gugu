import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUGU_APPS_REPO, type MarketIndexVersion } from '@shared/extensions/market';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import type { MarketSnapshotStore } from '@shared/extensions/market-snapshot';
import { CloudExtensionMarket, type BundleDownloadOptions, type MarketBackend } from './market-catalog';
import type { ReleaseTrustTable } from './release/market-release';
import { RELEASE_LEGAL_FILES, signTestRelease, testKey, testTrust, type SignedTestRelease } from './test-support/signed-release';

/**
 * #1931 A registered App (one the trust table names) installs from the market only as its signed release: the release is
 * fetched and verified before the package is, the package must be the one it signs, and what unpacks must be exactly the
 * files it lists. Every other App installs as before, its `release` unread.
 */

const APP = 'gugu-assistant';
const key = testKey();
const trust = testTrust(key, [APP]);

function manifestOf(id: string, version: string) {
  return { apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], id, name: `Extension ${id}`, version, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Main' }] } };
}

/** An App folder as the market compiles it: manifest, entry, the two legal files, and anything more. */
function appFiles(id: string, version: string, more: Record<string, string> = {}): Record<string, string> {
  return { 'manifest.json': JSON.stringify(manifestOf(id, version)), 'index.html': '<p>app</p>', ...RELEASE_LEGAL_FILES, ...more };
}

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content, { date: new Date(0) });
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-market-release-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Signs `files` (laid out in a folder, as the maintainer's build sees them) as the release of a package `zip`. */
function sign(id: string, version: string, files: Record<string, string>, zip: Uint8Array, over: Partial<Parameters<typeof signTestRelease>[0]> = {}): SignedTestRelease {
  const dir = fs.mkdtempSync(path.join(root, 'signed-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return signTestRelease({ appDir: dir, appId: id, version, zip, key, ...over });
}

class FakeSite implements MarketBackend {
  downloads: string[] = [];
  constructor(public index: unknown, public files: Record<string, Uint8Array>) {}
  readText(relativePath: string): Promise<string> {
    if (relativePath === 'index.json') return Promise.resolve(JSON.stringify(this.index));
    return Promise.reject(new Error(`market ${relativePath}: HTTP 404`));
  }
  download(relativePath: string, options: BundleDownloadOptions): Promise<Uint8Array> {
    this.downloads.push(relativePath);
    const bytes = this.files[relativePath];
    if (!bytes) return Promise.reject(new Error(`market ${relativePath}: HTTP 404`));
    if (bytes.byteLength > options.expectedBytes) return Promise.reject(new Error(`Bundle size mismatch: expected ${options.expectedBytes} bytes, got more than that`));
    return Promise.resolve(bytes);
  }
  urlOf(relativePath: string): string { return `https://download.example/market/${relativePath}`; }
}

function memoryStore(): MarketSnapshotStore {
  let text: string | null = null;
  return { read: () => Promise.resolve(text), write: (next: string) => { text = next; return Promise.resolve(); } };
}

function marketOf(site: MarketBackend, table: ReleaseTrustTable = trust, appVersion = '0.3.3'): CloudExtensionMarket {
  return new CloudExtensionMarket(site, {
    stagingRoot: path.join(root, 'staging'),
    heldRoot: path.join(root, 'held'),
    resolveHost: () => Promise.resolve({ platform: 'desktop' as const, appVersion, apiVersionMin: EXTENSION_API_VERSION, apiVersionMax: EXTENSION_API_VERSION }),
    snapshotStore: memoryStore(),
    scope: 'https://download.example/market/',
    releaseTrust: table,
  });
}

/** One market version row, its package, and (unless `release: false`) its signed release on the site, as gugu-apps' sync lays them out. */
async function published(id: string, version: string, options: { files?: Record<string, string>; release?: SignedTestRelease | false; zip?: Uint8Array } = {}) {
  const files = options.files ?? appFiles(id, version);
  const zip = options.zip ?? await zipOf(files);
  const at = `releases/${id}/${version}-${sha256(zip).slice(0, 12)}`;
  const release = options.release === false ? null : options.release ?? sign(id, version, files, zip);
  const row: MarketIndexVersion = {
    version, manifest: manifestOf(id, version), apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0', releaseNotes: `notes ${version}`,
    publishedAt: '2026-11-11T00:00:00Z', sha256: sha256(zip), bytes: zip.byteLength, bundle: `${at}/app.zip`, icon: null,
    source: { repo: GUGU_APPS_REPO, path: `releases/${id}/${version}`, commit: 'a'.repeat(40) }, yanked: null,
    ...(release ? { release: { keyId: release.release.keyId, manifest: `${at}/release.json`, signature: `${at}/release.sig` } } : {}),
  };
  const siteFiles: Record<string, Uint8Array> = { [row.bundle]: zip };
  if (release) Object.assign(siteFiles, { [`${at}/release.json`]: release.raw, [`${at}/release.sig`]: release.signature });
  return { row, zip, files: siteFiles, release };
}

const siteOf = (id: string, ...rows: Awaited<ReturnType<typeof published>>[]) =>
  new FakeSite({ apps: [{ id, deprecated: null, versions: rows.map((item) => item.row) }] }, Object.assign({}, ...rows.map((item) => item.files)));

describe('materialize, for an App the trust table names', () => {
  it('fetches and verifies its signed release before the package, and hands the verified release on', async () => {
    const item = await published(APP, '1.0.0');
    const site = siteOf(APP, item);
    const prepared = await marketOf(site).materialize(APP, '1.0.0');
    expect(site.downloads).toEqual([item.row.release!.manifest, item.row.release!.signature, item.row.bundle]);
    expect(prepared.release?.release).toMatchObject({ appId: APP, version: '1.0.0', keyId: key.id });
    expect(prepared.release?.proof).toEqual(item.release && item.release.proof);
    expect(fs.readFileSync(path.join(prepared.sourceDir, 'index.html'), 'utf8')).toBe('<p>app</p>');
  });

  it('refuses a version listed without a signed release, before downloading anything (no way round the signature)', async () => {
    const site = siteOf(APP, await published(APP, '1.0.0', { release: false }));
    await expect(marketOf(site).materialize(APP, '1.0.0')).rejects.toThrow(
      'Extension gugu-assistant@1.0.0 is listed without the signed release gugu requires for it. Nothing was downloaded.');
    expect(site.downloads).toEqual([]);
    expect(fs.existsSync(path.join(root, 'staging'))).toBe(false);
  });

  it('refuses a swapped package: index row and zip replaced, release.json and release.sig untouched', async () => {
    // The dry run's "not checked today" case: whoever can rewrite the index and the download site lists a package of their own
    // with a matching sha256, keeping the real release beside it. The release signs another package, so nothing unpacks.
    const real = await published(APP, '1.0.0');
    const forged = await zipOf(appFiles(APP, '1.0.0', { 'index.html': '<script>steal()</script>' }));
    const row = { ...real.row, sha256: sha256(forged), bytes: forged.byteLength };
    const site = new FakeSite({ apps: [{ id: APP, deprecated: null, versions: [row] }] }, { ...real.files, [row.bundle]: forged });
    await expect(marketOf(site).materialize(APP, '1.0.0')).rejects.toThrow(
      'Extension gugu-assistant@1.0.0 failed the release check: its signed release is for another package than the one the market lists. Nothing was unpacked.');
    expect(site.downloads).not.toContain(row.bundle);
  });

  it('refuses a swapped release.json, a signature by another key, a release of another version, and a revoked key', async () => {
    const real = await published(APP, '1.0.0');
    const other = await published(APP, '1.0.1');
    const cases: [string, FakeSite, ReleaseTrustTable, RegExp][] = [
      ['manifest swapped', new FakeSite({ apps: [{ id: APP, deprecated: null, versions: [real.row] }] }, { ...real.files, [real.row.release!.manifest]: Buffer.from((real.release as SignedTestRelease).raw.toString('utf8').replace('"rulesVersion": "1.0.0"', '"rulesVersion": "1.0.1"')) }), trust, /does not verify \(Release: invalid Ed25519 signature\)/],
      ['another key', siteOf(APP, await published(APP, '1.0.0', { release: sign(APP, '1.0.0', appFiles(APP, '1.0.0'), real.zip, { key: testKey(key.id) }) })), trust, /invalid Ed25519 signature/],
      ['another version', new FakeSite({ apps: [{ id: APP, deprecated: null, versions: [{ ...other.row, version: '1.0.0', manifest: manifestOf(APP, '1.0.0') }] }] }, other.files), trust, /untrusted release identity/],
      ['revoked', siteOf(APP, real), { schemaVersion: 1, keys: trust.keys.map((entry) => ({ ...entry, revoked: true })) }, /untrusted release identity/],
      ['empty slot', siteOf(APP, real), { schemaVersion: 1, keys: trust.keys.map((entry) => ({ ...entry, publicKey: null })) }, /untrusted release identity/],
    ];
    for (const [label, site, table, refusal] of cases) {
      await expect(marketOf(site, table).materialize(APP, '1.0.0'), label).rejects.toThrow(refusal);
      expect(site.downloads.filter((file) => file.endsWith('app.zip')), label).toEqual([]);
    }
  });

  it('refuses a release outside its signed desktop range', async () => {
    const files = appFiles(APP, '1.0.0');
    const zip = await zipOf(files);
    const site = siteOf(APP, await published(APP, '1.0.0', { zip, release: sign(APP, '1.0.0', files, zip, { desktop: { min: '0.3.4', maxExclusive: '0.4.0' } }) }));
    await expect(marketOf(site).materialize(APP, '1.0.0')).rejects.toThrow(/its signed release is for gugu 0\.3\.4 up to \(not including\) 0\.4\.0, not 0\.3\.3\. Nothing was unpacked\./);
  });

  it('refuses a package that unpacks to a file the release does not list, or without one it does; nothing stays', async () => {
    const listed = appFiles(APP, '1.0.0');
    const added = await zipOf({ ...listed, 'extra.js': 'x' });
    const missing = await zipOf(Object.fromEntries(Object.entries(listed).filter(([name]) => name !== 'index.html')));
    for (const [zip, problem] of [[added, 'extra.js is not in the signed release'], [missing, 'index.html is missing']] as const) {
      const site = siteOf(APP, await published(APP, '1.0.0', { zip, release: sign(APP, '1.0.0', listed, zip) }));
      await expect(marketOf(site).materialize(APP, '1.0.0')).rejects.toThrow(
        `Extension gugu-assistant@1.0.0 unpacked to files its signed release does not list (${problem}). Nothing was installed.`);
      expect(fs.readdirSync(path.join(root, 'staging'))).toEqual([]);
    }
  });

  it('a held copy counts only with its verified release and while its files are the signed ones', async () => {
    const site = siteOf(APP, await published(APP, '1.0.0'));
    const market = marketOf(site);
    const held = market.hold(await market.materialize(APP, '1.0.0'));
    expect((await market.held(APP, '1.0.0'))?.release?.release.version).toBe('1.0.0');
    // Another process (or after sweepHeld) has no verified release for it: fetch again.
    expect(await marketOf(site).held(APP, '1.0.0')).toBeNull();
    fs.writeFileSync(path.join(held.sourceDir, 'added.js'), 'x');
    expect(await market.held(APP, '1.0.0')).toBeNull();
    fs.rmSync(path.join(held.sourceDir, 'added.js'));
    fs.rmSync(path.join(held.sourceDir, 'index.html'));
    expect(await market.held(APP, '1.0.0')).toBeNull();
  });
});

describe('materialize, for an App the trust table does not name', () => {
  it('installs as before: one download, its release (if any) not read', async () => {
    for (const release of [false, undefined] as const) {
      const item = await published('radar', '1.0.0', { release });
      const site = siteOf('radar', item);
      const prepared = await marketOf(site).materialize('radar', '1.0.0');
      expect(site.downloads).toEqual([item.row.bundle]);
      expect(prepared.release).toBeUndefined();
    }
    // Even a release that would never verify is left unread.
    const item = await published('radar', '1.0.0');
    const site = new FakeSite({ apps: [{ id: 'radar', deprecated: null, versions: [{ ...item.row, release: { keyId: 'nobody', manifest: 'nowhere/release.json', signature: 'nowhere/release.sig' } }] }] }, item.files);
    await expect(marketOf(site).materialize('radar', '1.0.0')).resolves.toMatchObject({ sha256: item.row.sha256 });
    const market = marketOf(site);
    market.hold(await market.materialize('radar', '1.0.0'));
    expect(await marketOf(site).held('radar', '1.0.0')).not.toBeNull();
  });
});
