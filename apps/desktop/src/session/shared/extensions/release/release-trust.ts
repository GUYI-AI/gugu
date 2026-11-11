// #1931 Compiled market releases, checked by the client itself, on the desktop (main) and on the phone (the page). The
// gugu-apps market publishes a compiled App (its source is private) as a signed directory: `release.json` lists every
// file's sha256 and is signed with an Ed25519 key scoped to that App and its source repository. The market's CI checks the
// signature against its own trust table; the client checks it too, against the table it ships (release-keys.json), so the
// download site is not what the client trusts.
//
// The signature check is the market's own code (release-contract.mjs, mirrored byte for byte at a pinned commit), never a
// second implementation. It imports `node:crypto`: main gets Node's; the page bundle gets release-crypto-web.ts in its
// place (scripts/build/release-contract-browser-crypto.mts). Nothing here needs Node: bytes are Uint8Arrays, digests are
// WebCrypto's. An App the table does not name is installed exactly as before: its `release`, if any, is not read.
import { z } from 'zod'
import { compareExtensionVersions } from '../manifest'
import { semverCore, type MarketReleaseProof } from '../market'
import { verifyReleaseSignature, type ReleaseTrustKey, type SignedRelease } from './release-contract.mjs'
import shippedTable from './release-keys.json'

export type { SignedRelease }

/** The largest `release.json` the market accepts (release-contract.mjs) and the size of an Ed25519 signature. */
export const MAX_RELEASE_MANIFEST_BYTES = 512 * 1024
export const RELEASE_SIGNATURE_BYTES = 64

const ID = /^[a-z0-9][a-z0-9-]*$/
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
})
export const releaseTrustTableSchema = z.strictObject({ schemaVersion: z.literal(1), keys: z.array(trustEntrySchema) })
export type ReleaseTrustTable = z.infer<typeof releaseTrustTableSchema>

/** The table this build ships. Changed only by a reviewed change; read once. */
export const SHIPPED_RELEASE_TRUST: ReleaseTrustTable = releaseTrustTableSchema.parse(shippedTable)

/** Whether `appId` must arrive as a signed release: the table names it (with a key or a slot). */
export function releaseRequired(table: ReleaseTrustTable, appId: string): boolean {
  return table.keys.some((entry) => entry.appId === appId)
}

/** The entries with a key, as the market's contract reads them (it applies scope and `revoked` itself). */
function trustedKeys(table: ReleaseTrustTable): ReleaseTrustKey[] {
  return table.keys.flatMap(({ id, appId, sourceRepo, publicKey, revoked }) =>
    publicKey === null ? [] : [{ id, appId, sourceRepo, publicKey, ...(revoked === undefined ? {} : { revoked }) }])
}

/** Bytes as the contract reads them (`raw.toString('utf8')`, as a Node Buffer answers), on either platform. */
class ContractBytes extends Uint8Array {
  override toString(): string {
    return new TextDecoder().decode(this)
  }
}
const contractBytes = (bytes: Uint8Array) => new ContractBytes(bytes)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Verifies a downloaded release against the trust table: signature, key scope and revocation, the release being for this App
 * and version, its app package being the one the index names, and this gugu being inside its signed desktop range.
 * Returns the release; throws one line naming what failed.
 */
export function verifyMarketRelease(input: {
  appId: string
  version: string
  keyId: string
  raw: Uint8Array
  signature: Uint8Array
  appZip: { sha256: string; bytes: number }
  appVersion: string
}, table: ReleaseTrustTable): SignedRelease {
  let release: SignedRelease
  try {
    release = verifyReleaseSignature(contractBytes(input.raw), contractBytes(input.signature), input.keyId, trustedKeys(table), { appId: input.appId, version: input.version })
  } catch (error) {
    throw new Error(`its signed release does not verify (${messageOf(error)})`)
  }
  const app = release.artifacts.find((artifact) => artifact.role === 'app')
  if (!app || app.sha256 !== input.appZip.sha256 || app.bytes !== input.appZip.bytes) {
    throw new Error('its signed release is for another package than the one the market lists')
  }
  const { min, maxExclusive } = release.compatibility.desktop
  const at = semverCore(input.appVersion)
  if (!at || compareExtensionVersions(at, min) < 0 || compareExtensionVersions(at, maxExclusive) >= 0) {
    throw new Error(`its signed release is for gugu ${min} up to (not including) ${maxExclusive}, not ${input.appVersion}`)
  }
  return release
}

const base64Of = (bytes: Uint8Array) => {
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}
const bytesOfBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

/** The proof an install keeps, from the bytes that were verified. */
export function releaseProof(keyId: string, raw: Uint8Array, signature: Uint8Array): MarketReleaseProof {
  return { keyId, manifest: base64Of(raw), signature: base64Of(signature) }
}

/** Verifies a kept proof again for the installed App `appId@version`. Throws one line naming what failed. */
export function verifyReleaseProof(proof: MarketReleaseProof, expected: { appId: string; version: string }, table: ReleaseTrustTable): SignedRelease {
  let raw: Uint8Array
  let signature: Uint8Array
  try {
    raw = bytesOfBase64(proof.manifest)
    signature = bytesOfBase64(proof.signature)
  } catch {
    throw new Error('its kept release proof is malformed')
  }
  if (raw.length > MAX_RELEASE_MANIFEST_BYTES || signature.length !== RELEASE_SIGNATURE_BYTES) throw new Error('its kept release proof is malformed')
  try {
    return verifyReleaseSignature(contractBytes(raw), contractBytes(signature), proof.keyId, trustedKeys(table), expected)
  } catch (error) {
    throw new Error(`its kept release proof does not verify (${messageOf(error)})`)
  }
}

/** One file as the release lists it, and as it was found. */
export interface FileDigest { sha256: string; bytes: number }

/** The App's own files a release signs: `app/` without the market listing (`app/store/`), which is never in the package. */
function signedAppFiles(release: SignedRelease): Map<string, FileDigest> {
  const files = new Map<string, FileDigest>()
  for (const file of release.files) {
    if (file.path.startsWith('app/') && !file.path.startsWith('app/store/')) files.set(file.path.slice('app/'.length), { sha256: file.sha256, bytes: file.bytes })
  }
  return files
}

/** Whether `relative` is inside `within` (a folder ends with `/`); none: everything is. */
export function withinScope(relative: string, within?: readonly string[]): boolean {
  return !within || within.some((entry) => (entry.endsWith('/') ? relative.startsWith(entry) : relative === entry))
}

/**
 * How the App's files (`found`: path within the App → digest) differ from its signed release: a file not signed, a signed
 * file missing or changed. `within` limits both sides to some paths (a folder ends with `/`); none: every file. The one
 * comparison the desktop (files on disk) and the phone (files in memory) both use.
 */
export function signedFileProblems(found: ReadonlyMap<string, FileDigest>, release: SignedRelease, within?: readonly string[]): string[] {
  const expected = new Map([...signedAppFiles(release)].filter(([relative]) => withinScope(relative, within)))
  const problems: string[] = []
  for (const [relative, digest] of found) {
    if (!withinScope(relative, within)) continue
    const signed = expected.get(relative)
    if (!signed) problems.push(`${relative} is not in the signed release`)
    else if (digest.bytes !== signed.bytes || digest.sha256 !== signed.sha256) problems.push(`${relative} differs from the signed release`)
  }
  for (const relative of expected.keys()) if (!found.has(relative)) problems.push(`${relative} is missing`)
  return problems
}

/** SHA-256 of some bytes, hex: WebCrypto's, on the desktop and the phone alike. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** One line for a list of problems: the first, and how many more. */
export function firstProblem(problems: readonly string[]): string {
  return problems.length > 1 ? `${problems[0]}, and ${problems.length - 1} more` : problems[0] ?? ''
}
