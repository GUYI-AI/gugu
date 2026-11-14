// Test support for compiled market releases (#1931): signs a release of an App folder the way the gugu-apps market's
// maintainer does (release.json + Ed25519 signature), with key pairs made here in the test process — never written to disk,
// never a release key. The trust tables built here name them; the shipped table is never touched.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketReleaseProof } from '@shared/extensions/market';
import type { ReleaseTrustTable, SignedRelease } from '../release/market-release';

export const TEST_SOURCE_REPO = 'GUYI-AI/gugu-assistant';
export const TEST_KEY_ID = 'test-release-key';

export interface TestKey { id: string; privateKey: KeyObject; publicKey: string }

/** A fresh Ed25519 key pair, in memory only. */
export function testKey(id = TEST_KEY_ID): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { id, privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** A trust table naming `key` for each of `appIds` (and, if given, more entries as they are). */
export function testTrust(key: TestKey, appIds: readonly string[], more: ReleaseTrustTable['keys'] = []): ReleaseTrustTable {
  return { schemaVersion: 1, keys: [...appIds.map((appId) => ({ id: key.id, appId, sourceRepo: TEST_SOURCE_REPO, publicKey: key.publicKey })), ...more] };
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Every file under `dir`, as the release lists it: `app/<path>`. */
function appFiles(dir: string, at = ''): { path: string; sha256: string; bytes: number }[] {
  return readdirSync(join(dir, at), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en-US')).flatMap((entry) => {
    const relative = at ? `${at}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return appFiles(dir, relative);
    const bytes = readFileSync(join(dir, relative));
    return [{ path: `app/${relative}`, sha256: sha256(bytes), bytes: bytes.length }];
  });
}

export interface SignedTestRelease {
  release: SignedRelease;
  raw: Buffer;
  signature: Buffer;
  proof: MarketReleaseProof;
}

/**
 * Signs a release of the App folder `appDir` (it must hold manifest.json, LICENSE and THIRD_PARTY_NOTICES.md, as the market
 * requires) for `appId@version`, whose package is `zip` (its sha256 and size; for an install that bypasses the market, any
 * bytes stand in). `change` edits the release before it is signed, to make one that lies.
 */
export function signTestRelease(input: {
  appDir: string;
  appId: string;
  version: string;
  zip: { sha256: string; bytes: number } | Uint8Array;
  key: TestKey;
  desktop?: { min: string; maxExclusive: string };
  change?: (release: SignedRelease) => void;
}): SignedTestRelease {
  const zip = input.zip instanceof Uint8Array ? { sha256: sha256(input.zip), bytes: input.zip.byteLength } : input.zip;
  const commit = 'a'.repeat(40);
  const files = [{ path: 'app.zip', ...zip }, ...appFiles(input.appDir)];
  const release: SignedRelease = {
    schemaVersion: 1, appId: input.appId, productId: input.appId, version: input.version, keyId: input.key.id,
    source: { repo: TEST_SOURCE_REPO, commit },
    build: { repo: TEST_SOURCE_REPO, commit, workflow: '.github/workflows/release-candidate.yml', runId: '1', lockSha256: 'b'.repeat(64), node: 'v24.14.0' },
    review: { url: `https://github.com/${TEST_SOURCE_REPO}/pull/1#pullrequestreview-1`, author: 'author', reviewer: 'reviewer', commit },
    compatibility: {
      desktop: input.desktop ?? { min: '0.0.1', maxExclusive: '99.0.0' }, server: { min: '0.0.1', maxExclusive: '99.0.0' },
      api: { min: 1, max: 999 }, data: { read: { min: 1, max: 1 }, write: { min: 1, max: 1 } },
    },
    rulesVersion: '1.0.0',
    artifacts: [{ role: 'app', path: 'app.zip', ...zip }],
    files,
  };
  input.change?.(release);
  const raw = Buffer.from(`${JSON.stringify(release, null, 2)}\n`);
  const signature = sign(null, raw, input.key.privateKey);
  return { release, raw, signature, proof: { keyId: input.key.id, manifest: raw.toString('base64'), signature: signature.toString('base64') } };
}

/** The two files every compiled release carries in its App folder (validateRelease requires them). */
export const RELEASE_LEGAL_FILES: Readonly<Record<string, string>> = Object.freeze({ LICENSE: 'Test fixture only.\n', 'THIRD_PARTY_NOTICES.md': 'Test fixture only.\n' });
