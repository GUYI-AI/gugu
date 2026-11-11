import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { GUGU_APPS_REPO, type MarketIndexVersion } from '@shared/extensions/market';
import { ExtensionsService } from './extensions-service';
import { packExtensionArchive } from './extension-archive';
import { CloudExtensionMarket, type BundleDownloadOptions, type MarketBackend } from './market-catalog';
import { RELEASE_LEGAL_FILES, signTestRelease, testKey, testTrust, type SignedTestRelease } from './test-support/signed-release';

// #1931 A registered App installed from the market, every way it is installed (silently as gugu's own, or asked about):
// only its signed release goes in, and the install keeps the verified proof beside where its code is.
const state = vi.hoisted(() => ({ service: null as unknown, userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service }));

const { installExtensionFromMarket } = await import('./extension-market-install');
const { events } = await import('@main/lib/events');
vi.spyOn(events, 'emit').mockImplementation(() => undefined as never);

const APP = 'gugu-assistant';
const key = testKey();
const quiet = { afterInstall: () => {}, notifyInstalledChanged: async () => {} };
const source = { repo: GUGU_APPS_REPO, path: `releases/${APP}/1.0.0`, commit: 'a'.repeat(40) };
let work: string;
let service: ExtensionsService;

class Site implements MarketBackend {
  downloads: string[] = [];
  constructor(public index: { apps: unknown[] }, private readonly files: Record<string, Uint8Array>) {}
  readText(relativePath: string): Promise<string> {
    if (relativePath !== 'index.json') return Promise.reject(new Error(`HTTP 404 ${relativePath}`));
    return Promise.resolve(JSON.stringify(this.index));
  }
  download(relativePath: string, _options: BundleDownloadOptions): Promise<Uint8Array> {
    this.downloads.push(relativePath);
    const bytes = this.files[relativePath];
    return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`HTTP 404 ${relativePath}`));
  }
  urlOf(relativePath: string): string { return `https://download.test/market/${relativePath}`; }
}

/** An App folder with what a compiled release carries; `html` is its page. */
function appDir(name: string, html: string, permissions?: { network: string[] }) {
  const dir = path.join(work, 'src', name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id: APP, name: 'Assistant', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    ...(permissions ? { permissions } : {}), contributes: { tabs: [{ name: 'main', title: 'Assistant' }] },
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'index.html'), html);
  for (const [file, text] of Object.entries(RELEASE_LEGAL_FILES)) writeFileSync(path.join(dir, file), text);
  return { dir, manifest };
}

/**
 * Publishes the App as a compiled release; `forged` swaps in another package (and an index row that matches it) while
 * release.json and release.sig stay the real ones — the dry run's case that nothing checked before #1931.
 */
async function publish(options: { forged?: boolean; permissions?: { network: string[] } } = {}) {
  const real = appDir('real', '<p>assistant</p>', options.permissions);
  const packed = await packExtensionArchive(service, real.dir);
  const release: SignedTestRelease = signTestRelease({ appDir: real.dir, appId: APP, version: '1.0.0', zip: new Uint8Array(packed.bytes), key });
  const served = options.forged ? await packExtensionArchive(service, appDir('forged', '<script>steal()</script>', options.permissions).dir) : packed;
  const at = `releases/${APP}/1.0.0-${packed.sha256.slice(0, 12)}`;
  const row: MarketIndexVersion = {
    version: '1.0.0', manifest: real.manifest, apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0', releaseNotes: 'First public release.',
    publishedAt: '2026-11-11T00:00:00Z', sha256: served.sha256, bytes: served.bytes.byteLength, bundle: `${at}/app.zip`, icon: null,
    source, yanked: null, release: { keyId: key.id, manifest: `${at}/release.json`, signature: `${at}/release.sig` },
  };
  const site = new Site({ apps: [{ id: APP, deprecated: null, versions: [row] }] }, {
    [row.bundle]: new Uint8Array(served.bytes), [row.release!.manifest]: release.raw, [row.release!.signature]: release.signature,
  });
  const market = new CloudExtensionMarket(site, {
    stagingRoot: path.join(state.userData, 'extension-market', 'staging'),
    heldRoot: path.join(state.userData, 'extension-market', 'held'),
    resolveHost: async () => ({ platform: 'desktop' as const, appVersion: '0.3.3', apiVersionMin: EXTENSION_API_VERSION, apiVersionMax: EXTENSION_API_VERSION }),
    snapshotStore: { read: async () => null, write: async () => undefined },
    releaseTrust: testTrust(key, [APP]),
  });
  return { site, market, release, row };
}

const sourcesFile = () => path.join(state.userData, 'task-extensions', '.extension-market-sources.json');
function leftovers(): string[] {
  const root = path.join(state.userData, 'extension-market');
  return ['staging', 'held'].flatMap((folder) => (existsSync(path.join(root, folder)) ? readdirSync(path.join(root, folder)).map((name) => `${folder}/${name}`) : []));
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'gugu-market-release-install-'));
  state.userData = path.join(work, 'userData');
  service = new ExtensionsService(path.join(state.userData, 'task-extensions'));
  state.service = service;
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('a registered App from the market', () => {
  it('silently, as gugu’s own: installs the signed release and keeps its verified proof with its source', async () => {
    const { market, release } = await publish();
    await expect(installExtensionFromMarket({ ref: { extensionId: APP, version: '1.0.0' }, consent: { kind: 'gugu' } }, { ...quiet, market }))
      .resolves.toMatchObject({ installed: true, id: APP, asked: false });
    expect(service.marketSource(APP)).toEqual({ ...source, release: release.proof });
    expect(JSON.parse(readFileSync(sourcesFile(), 'utf8'))[APP].release.keyId).toBe(key.id);
    expect(leftovers()).toEqual([]);
  });

  it('asked about (`return`, then `given`): the held copy is the verified one, fetched once, and its proof is kept', async () => {
    const { site, market, release } = await publish({ permissions: { network: ['api.example.com'] } });
    const asked = await installExtensionFromMarket({ ref: { extensionId: APP }, consent: { kind: 'return' } }, { ...quiet, market });
    const digest = asked.outcome === 'ask' ? asked.ask.manifestDigest : '';
    await expect(installExtensionFromMarket({ ref: { extensionId: APP, version: '1.0.0' }, consent: { kind: 'given', digest } }, { ...quiet, market }))
      .resolves.toMatchObject({ installed: true, id: APP });
    expect(site.downloads.filter((file) => file.endsWith('app.zip'))).toHaveLength(1);
    expect(service.marketSource(APP)?.release).toEqual(release.proof);
    expect(leftovers()).toEqual([]);
  });

  it('regression (dry run, "not checked today"): a forged package with a matching index row is refused, both ways in', async () => {
    const { site, market } = await publish({ forged: true });
    await expect(installExtensionFromMarket({ ref: { extensionId: APP, version: '1.0.0' }, consent: { kind: 'gugu' } }, { ...quiet, market }))
      .rejects.toThrow('Extension gugu-assistant@1.0.0 failed the release check: its signed release is for another package than the one the market lists. Nothing was unpacked.');
    await expect(installExtensionFromMarket({ ref: { extensionId: APP, version: '1.0.0' } }, { ...quiet, market, requestInstallConsent: vi.fn().mockResolvedValue({ outcome: 'confirmed' }) }))
      .rejects.toThrow(/failed the release check/);
    expect(site.downloads.some((file) => file.endsWith('app.zip'))).toBe(false);
    expect(service.list().extensions).toEqual([]);
    expect(existsSync(sourcesFile())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('records kept before releases (repo, path, commit only) still read, and a malformed proof is not taken as one', () => {
    mkdirSync(path.dirname(sourcesFile()), { recursive: true });
    writeFileSync(sourcesFile(), JSON.stringify({ radar: { repo: GUGU_APPS_REPO, path: 'sources/radar', commit: 'b'.repeat(40) } }));
    expect(service.marketSource('radar')).toEqual({ repo: GUGU_APPS_REPO, path: 'sources/radar', commit: 'b'.repeat(40) });
    expect(service.marketSource(APP)).toBeNull();
    writeFileSync(sourcesFile(), JSON.stringify({ [APP]: { ...source, release: { keyId: key.id, manifest: 1 } } }));
    expect(() => service.marketSource(APP)).toThrow();
  });
});
