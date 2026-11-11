// #1931 Compiled market releases, checked by the client itself. The gugu-apps market publishes a compiled App (its source is
// private) as a signed directory: `release.json` lists every file's sha256 and is signed with an Ed25519 key scoped to that App
// and its source repository. The market's CI checks the signature against its own trust table; this module makes the
// client check it too, against the trust table it ships (release-keys.json), so the download site is not what the client
// trusts:
// - before a registered App is unpacked: its signed release verifies, and is for exactly the package the index names;
// - after it is unpacked: the files are exactly the signed ones;
// - whenever the host decides whether to believe the installed App (assistant-rules-trust.ts): the proof kept at install
//   verifies again, and the files that matter are still the signed ones.
// The signature check is the market's own code (release-contract.mjs, mirrored byte for byte at a pinned commit), never a
// second implementation. An App the table does not name is installed exactly as before: its `release`, if any, is not read.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { semverCore, type MarketCodeSource, type MarketInstallRecord, type MarketReleaseProof } from '@shared/extensions/market';
import { verifyReleaseSignature, type ReleaseTrustKey, type SignedRelease } from './release-contract.mjs';
import shippedTable from './release-keys.json';

export type { SignedRelease };

/** The largest `release.json` the market accepts (release-contract.mjs) and the size of an Ed25519 signature. */
export const MAX_RELEASE_MANIFEST_BYTES = 512 * 1024;
export const RELEASE_SIGNATURE_BYTES = 64;

const ID = /^[a-z0-9][a-z0-9-]*$/;
/**
 * One entry of the trust table. `publicKey: null` is a slot: the App is registered (its installs must be signed) but no key
 * is trusted yet, so none of its releases verifies; a production build refuses to start with one (release-trust-keys.mts).
 */
const trustEntrySchema = z.strictObject({
  id: z.string().regex(ID),
  appId: z.string().regex(ID),
  sourceRepo: z.string().regex(/^GUYI-AI\/[A-Za-z0-9._-]+$/),
  publicKey: z.string().min(1).nullable(),
  revoked: z.boolean().optional(),
  note: z.string().optional(),
});
export const releaseTrustTableSchema = z.strictObject({ schemaVersion: z.literal(1), keys: z.array(trustEntrySchema) });
export type ReleaseTrustTable = z.infer<typeof releaseTrustTableSchema>;

/** The table this build ships. Changed only by a reviewed change; read once. */
export const SHIPPED_RELEASE_TRUST: ReleaseTrustTable = releaseTrustTableSchema.parse(shippedTable);

/** Whether `appId` must arrive as a signed release: the table names it (with a key or a slot). */
export function releaseRequired(table: ReleaseTrustTable, appId: string): boolean {
  return table.keys.some((entry) => entry.appId === appId);
}

/** The entries with a key, as the market's contract reads them (it applies scope and `revoked` itself). */
function trustedKeys(table: ReleaseTrustTable): ReleaseTrustKey[] {
  return table.keys.flatMap(({ id, appId, sourceRepo, publicKey, revoked }) =>
    publicKey === null ? [] : [{ id, appId, sourceRepo, publicKey, ...(revoked === undefined ? {} : { revoked }) }]);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Verifies a downloaded release against the trust table: signature, key scope and revocation, the release being for this App
 * and version, its app package being the one the index names, and this gugu being inside its signed desktop range.
 * Returns the release; throws one line naming what failed.
 */
export function verifyMarketRelease(input: {
  appId: string;
  version: string;
  keyId: string;
  raw: Uint8Array;
  signature: Uint8Array;
  appZip: { sha256: string; bytes: number };
  appVersion: string;
}, table: ReleaseTrustTable): SignedRelease {
  let release: SignedRelease;
  try {
    release = verifyReleaseSignature(Buffer.from(input.raw), Buffer.from(input.signature), input.keyId, trustedKeys(table), { appId: input.appId, version: input.version });
  } catch (error) {
    throw new Error(`its signed release does not verify (${messageOf(error)})`);
  }
  const app = release.artifacts.find((artifact) => artifact.role === 'app');
  if (!app || app.sha256 !== input.appZip.sha256 || app.bytes !== input.appZip.bytes) {
    throw new Error('its signed release is for another package than the one the market lists');
  }
  const { min, maxExclusive } = release.compatibility.desktop;
  const at = semverCore(input.appVersion);
  if (!at || compareExtensionVersions(at, min) < 0 || compareExtensionVersions(at, maxExclusive) >= 0) {
    throw new Error(`its signed release is for gugu ${min} up to (not including) ${maxExclusive}, not ${input.appVersion}`);
  }
  return release;
}

/** What a market install records about its bytes (extensions-service `MARKET_SOURCES_FILENAME`): the source, and the verified proof. */
export function marketInstallRecord(prepared: { source: MarketCodeSource; release?: { proof: MarketReleaseProof } }): MarketInstallRecord {
  const { repo, path: folder, commit } = prepared.source;
  return { repo, path: folder, commit, ...(prepared.release ? { release: prepared.release.proof } : {}) };
}

/** The proof an install keeps, from the bytes that were verified. */
export function releaseProof(keyId: string, raw: Uint8Array, signature: Uint8Array): MarketReleaseProof {
  return { keyId, manifest: Buffer.from(raw).toString('base64'), signature: Buffer.from(signature).toString('base64') };
}

/**
 * Verifies a kept proof again for the installed App `appId@version`. Throws one line naming what failed.
 */
export function verifyReleaseProof(proof: MarketReleaseProof, expected: { appId: string; version: string }, table: ReleaseTrustTable): SignedRelease {
  const raw = Buffer.from(proof.manifest, 'base64');
  const signature = Buffer.from(proof.signature, 'base64');
  if (raw.length > MAX_RELEASE_MANIFEST_BYTES || signature.length !== RELEASE_SIGNATURE_BYTES) throw new Error('its kept release proof is malformed');
  try {
    return verifyReleaseSignature(raw, signature, proof.keyId, trustedKeys(table), expected);
  } catch (error) {
    throw new Error(`its kept release proof does not verify (${messageOf(error)})`);
  }
}

/** The App's own files a release signs: `app/` without the market listing (`app/store/`), which is never in the package. */
function signedAppFiles(release: SignedRelease): Map<string, { sha256: string; bytes: number }> {
  const files = new Map<string, { sha256: string; bytes: number }>();
  for (const file of release.files) {
    if (file.path.startsWith('app/') && !file.path.startsWith('app/store/')) files.set(file.path.slice('app/'.length), { sha256: file.sha256, bytes: file.bytes });
  }
  return files;
}

/**
 * How the App's files in `dir` differ from its signed release: a file not signed, a signed file missing or changed, anything
 * that is not a regular file. `within` limits both sides to some paths (a folder ends with `/`); none: every file.
 */
export function releaseFileProblems(dir: string, release: SignedRelease, within?: readonly string[]): string[] {
  const inScope = (relative: string) => !within || within.some((entry) => (entry.endsWith('/') ? relative.startsWith(entry) : relative === entry));
  const expected = new Map([...signedAppFiles(release)].filter(([relative]) => inScope(relative)));
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = (relative: string) => {
    const full = path.join(dir, relative);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(full, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(child); continue; }
      if (!inScope(child)) continue;
      if (!entry.isFile()) { problems.push(`${child} is not a regular file`); continue; }
      seen.add(child);
      const signed = expected.get(child);
      if (!signed) { problems.push(`${child} is not in the signed release`); continue; }
      const bytes = fs.readFileSync(path.join(dir, child));
      if (bytes.length !== signed.bytes || createHash('sha256').update(bytes).digest('hex') !== signed.sha256) problems.push(`${child} differs from the signed release`);
    }
  };
  walk('');
  for (const relative of expected.keys()) if (!seen.has(relative)) problems.push(`${relative} is missing`);
  return problems;
}

/** One line for a list of problems: the first, and how many more. */
export function firstProblem(problems: readonly string[]): string {
  return problems.length > 1 ? `${problems[0]}, and ${problems.length - 1} more` : problems[0] ?? '';
}
