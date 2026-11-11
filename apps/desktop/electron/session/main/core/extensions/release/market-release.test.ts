import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pin from '@shared/extensions/release/release-contract.pin.json';
import {
  marketInstallRecord,
  releaseFileProblems,
  releaseProof,
  releaseRequired,
  releaseTrustTableSchema,
  SHIPPED_RELEASE_TRUST,
  verifyMarketRelease,
  verifyReleaseProof,
} from './market-release';
import { RELEASE_LEGAL_FILES, signTestRelease, testKey, testTrust } from '../test-support/signed-release';

// #1931 The client's own check of a compiled market release: the market's contract (mirrored byte for byte), the shipped
// trust table, and every way a release can fail to be the one signed for this App, version and package.
const key = testKey();
const trust = testTrust(key, ['gugu-assistant']);
const zip = { sha256: 'c'.repeat(64), bytes: 1234 };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'market-release-'));
  mkdirSync(join(dir, 'rules'));
  writeFileSync(join(dir, 'manifest.json'), '{"id":"gugu-assistant","version":"1.0.0"}');
  writeFileSync(join(dir, 'rules', 'rules.json'), '{}');
  writeFileSync(join(dir, 'today.js'), 'console.log(1)');
  for (const [name, text] of Object.entries(RELEASE_LEGAL_FILES)) writeFileSync(join(dir, name), text);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signed = (change?: Parameters<typeof signTestRelease>[0]['change'], over: Partial<Parameters<typeof signTestRelease>[0]> = {}) =>
  signTestRelease({ appDir: dir, appId: 'gugu-assistant', version: '1.0.0', zip, key, change, ...over });
const verify = (s: ReturnType<typeof signed>, over: Partial<Parameters<typeof verifyMarketRelease>[0]> = {}, table = trust) =>
  verifyMarketRelease({ appId: 'gugu-assistant', version: '1.0.0', keyId: key.id, raw: s.raw, signature: s.signature, appZip: zip, appVersion: '0.3.3', ...over }, table);

describe('the mirrored market contract and the shipped trust table', () => {
  it('release-contract.mjs is byte for byte the gugu-apps file at the pinned commit', () => {
    // The pin's sha256 is the pinned commit's file (its `check` field says how to re-read it there); any edit to the
    // mirror, or a pin moved without the mirror, fails here.
    expect(pin).toMatchObject({ repo: 'GUYI-AI/gugu-apps', path: 'scripts/release-contract.mjs' });
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    const bytes = readFileSync(new URL('../../../../../../src/session/shared/extensions/release/release-contract.mjs', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.sha256);
  });

  it('the shipped table registers gugu-assistant, with a key or a clearly marked slot for gugu-assistant-release-1', () => {
    expect(releaseRequired(SHIPPED_RELEASE_TRUST, 'gugu-assistant')).toBe(true);
    expect(releaseRequired(SHIPPED_RELEASE_TRUST, 'radar')).toBe(false);
    const entry = SHIPPED_RELEASE_TRUST.keys.find((item) => item.id === 'gugu-assistant-release-1');
    expect(entry).toMatchObject({ appId: 'gugu-assistant', sourceRepo: 'GUYI-AI/gugu-assistant' });
    if (entry!.publicKey === null) expect(entry!.note).toMatch(/^SLOT: /);
    else expect(entry!.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(() => releaseTrustTableSchema.parse({ schemaVersion: 1, keys: [{ ...entry, revoked: 'false' }] })).toThrow();
  });
});

describe('verifying a downloaded release', () => {
  it('accepts the release signed for this App, version and package, inside its desktop range', () => {
    const s = signed();
    expect(verify(s)).toMatchObject({ appId: 'gugu-assistant', version: '1.0.0', keyId: key.id });
    expect(verifyReleaseProof(releaseProof(key.id, s.raw, s.signature), { appId: 'gugu-assistant', version: '1.0.0' }, trust).version).toBe('1.0.0');
  });

  it('refuses a changed manifest, a signature by another key, another version or App, and a revoked or empty key', () => {
    const s = signed();
    const swapped = Buffer.from(s.raw.toString('utf8').replace('"rulesVersion": "1.0.0"', '"rulesVersion": "9.0.0"'));
    expect(() => verify(s, { raw: swapped })).toThrow(/does not verify \(Release: invalid Ed25519 signature\)/);
    const impostor = testKey(key.id);
    expect(() => verify(signed(undefined, { key: impostor }))).toThrow(/invalid Ed25519 signature/);
    expect(() => verify(signed(undefined, { version: '1.0.1' }))).toThrow(/untrusted release identity/);
    expect(() => verify(s, { version: '1.0.1' })).toThrow(/untrusted release identity/);
    // Signed for another App with the same key, and a key trusted only for another App.
    expect(() => verify(signed(undefined, { appId: 'other-app' }))).toThrow(/untrusted release identity/);
    expect(() => verify(s, {}, testTrust(key, ['other-app']))).toThrow(/untrusted release identity/);
    // Revoked, an empty slot, a key id the table does not have.
    expect(() => verify(s, {}, { schemaVersion: 1, keys: trust.keys.map((entry) => ({ ...entry, revoked: true })) })).toThrow(/untrusted/);
    expect(verify(s, {}, { schemaVersion: 1, keys: trust.keys.map((entry) => ({ ...entry, revoked: false })) }).version).toBe('1.0.0');
    expect(() => verify(s, {}, { schemaVersion: 1, keys: trust.keys.map((entry) => ({ ...entry, publicKey: null })) })).toThrow(/untrusted/);
    expect(() => verify(s, { keyId: 'another-key' })).toThrow(/untrusted/);
    // Signed by the source repo the key is not scoped to.
    expect(() => verify(signed((release) => { release.source.repo = 'GUYI-AI/other'; release.build.repo = 'GUYI-AI/other'; release.review.url = 'https://github.com/GUYI-AI/other/pull/1#pullrequestreview-1'; }))).toThrow(/untrusted/);
  });

  it('refuses a release for another package, and outside its signed desktop range', () => {
    const s = signed();
    expect(() => verify(s, { appZip: { ...zip, sha256: 'd'.repeat(64) } })).toThrow(/for another package/);
    expect(() => verify(s, { appZip: { ...zip, bytes: 1235 } })).toThrow(/for another package/);
    const ranged = signed(undefined, { desktop: { min: '0.3.3', maxExclusive: '0.4.0' } });
    expect(verify(ranged, { appVersion: '0.3.3-beta.4' }).version).toBe('1.0.0');
    expect(() => verify(ranged, { appVersion: '0.3.2' })).toThrow(/for gugu 0\.3\.3 up to \(not including\) 0\.4\.0, not 0\.3\.2/);
    expect(() => verify(ranged, { appVersion: '0.4.0' })).toThrow(/not 0\.4\.0/);
  });

  it('a kept proof that is cut short or not for this version does not verify', () => {
    const { proof } = signed();
    expect(() => verifyReleaseProof({ ...proof, signature: Buffer.alloc(10).toString('base64') }, { appId: 'gugu-assistant', version: '1.0.0' }, trust)).toThrow(/malformed/);
    expect(() => verifyReleaseProof(proof, { appId: 'gugu-assistant', version: '2.0.0' }, trust)).toThrow(/does not verify/);
    expect(marketInstallRecord({ source: { repo: 'r/r', path: 'p', commit: 'c' } })).toEqual({ repo: 'r/r', path: 'p', commit: 'c' });
    expect(marketInstallRecord({ source: { repo: 'r/r', path: 'p', commit: 'c' }, release: { proof } }).release).toBe(proof);
  });
});

describe('the files against the signed release', () => {
  it('finds none when they are the signed ones, and names an added, a missing, a changed file and a link', () => {
    const release = signed();
    expect(releaseFileProblems(dir, release.release)).toEqual([]);
    writeFileSync(join(dir, 'extra.js'), 'x');
    rmSync(join(dir, 'today.js'));
    writeFileSync(join(dir, 'rules', 'rules.json'), '{"changed":true}');
    symlinkSync('manifest.json', join(dir, 'link.json'));
    expect(releaseFileProblems(dir, release.release).sort()).toEqual([
      'extra.js is not in the signed release', 'link.json is not a regular file', 'rules/rules.json differs from the signed release', 'today.js is missing',
    ]);
    // Looking only at the manifest and the rules folder: the rest is not read.
    expect(releaseFileProblems(dir, release.release, ['manifest.json', 'rules/'])).toEqual(['rules/rules.json differs from the signed release']);
  });

  it('never counts the market listing (app/store/) as a file of the App', () => {
    mkdirSync(join(dir, 'store'));
    writeFileSync(join(dir, 'store', 'about.md'), 'listing');
    const release = signed();
    expect(release.release.files.some((file) => file.path === 'app/store/about.md')).toBe(true);
    rmSync(join(dir, 'store'), { recursive: true });
    expect(releaseFileProblems(dir, release.release)).toEqual([]);
  });
});
