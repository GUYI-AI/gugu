// #1931 `node:crypto` for the market's release contract (release-contract.mjs, mirrored byte for byte) where there is no
// Node: the page bundle, which the phone runs in its WebView. The contract calls `createPublicKey(pem)` and
// `verify(null, raw, key, signature)` for one Ed25519 signature, synchronously; nothing else here is used by it
// (`createHash` backs only its `digest`, which the client never calls).
//
// WebCrypto cannot stand in: its Ed25519 is recent (a WebView that never updated has none) and asynchronous. The
// verification is @noble/curves' Ed25519 (audited pure JS, no dependency but @noble/hashes), in its strict RFC 8032 /
// FIPS 186-5 mode — the rules Node's OpenSSL applies, not the more permissive ZIP-215 default.
// scripts/build/release-contract-browser-crypto.mts serves this module to the contract in place of `node:crypto`.
import { ed25519 } from '@noble/curves/ed25519.js'

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING (33) }. */
const ED25519_SPKI_PREFIX = Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
const PEM = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n-----END PUBLIC KEY-----\r?\n?$/

/** A public key as the contract sees it: its type (Node's `KeyObject.asymmetricKeyType`) and, for Ed25519, its 32 bytes. */
export interface WebPublicKey {
  readonly asymmetricKeyType: string
  readonly raw: Uint8Array | null
}

/** Node's `createPublicKey` for an SPKI PEM string: Ed25519 keys are read; any other well-formed key is a type the contract refuses. */
export function createPublicKey(pem: unknown): WebPublicKey {
  const body = typeof pem === 'string' ? PEM.exec(pem)?.[1] : undefined
  if (!body) throw new Error('the public key is not an SPKI PEM')
  let der: Uint8Array
  try { der = Uint8Array.from(atob(body.replace(/\r?\n/g, '')), (char) => char.charCodeAt(0)) }
  catch { throw new Error('the public key is not an SPKI PEM') }
  const ed25519Key = der.length === ED25519_SPKI_PREFIX.length + 32 && ED25519_SPKI_PREFIX.every((byte, at) => der[at] === byte)
  return ed25519Key ? { asymmetricKeyType: 'ed25519', raw: der.slice(ED25519_SPKI_PREFIX.length) } : { asymmetricKeyType: 'unsupported', raw: null }
}

/** Node's one-shot `verify(null, data, key, signature)` for an Ed25519 key; anything else does not verify. */
export function verify(algorithm: unknown, data: Uint8Array, key: WebPublicKey, signature: Uint8Array): boolean {
  if (algorithm !== null && algorithm !== undefined) throw new Error('only Ed25519 (algorithm null) is supported here')
  if (key.asymmetricKeyType !== 'ed25519' || !key.raw || signature.length !== 64) return false
  try { return ed25519.verify(Uint8Array.from(signature), Uint8Array.from(data), key.raw, { zip215: false }) }
  catch { return false }
}

/** Not available in the page: the client hashes with WebCrypto (release-trust.ts `sha256Hex`). */
export function createHash(): never {
  throw new Error('createHash is not available in the page bundle')
}
