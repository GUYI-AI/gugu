import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { VaultError } from './contracts'
import { decode, seal, unseal } from './crypto'

/**
 * Cryptography for end-to-end vault sync (SYNC.md). Symmetric parts reuse the vault's AES-256-GCM (`crypto.ts`). A
 * device is one Ed25519 key (kept as its 32-byte seed): it signs membership with it, and sealed shares reach it through
 * the X25519 key derived from it (libsodium's conversion). Nothing here touches the network or disk.
 */
const loadSodium = async () => {
  const { default: sodium } = await import('libsodium-wrappers')
  await sodium.ready
  return sodium
}
const KEY_BYTES = 32
const NONCE_BYTES = 32
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
/** libsodium checks `instanceof Uint8Array` against its own realm; a Buffer from another realm (test DOMs) fails it. */
const plain = (bytes: Uint8Array) => new Uint8Array(bytes)
/** Associated data: an array of fields, encoded so no field can run into the next. */
export const aad = (...parts: (string | number)[]) => JSON.stringify(['gugu-vault-sync-v1', ...parts.map(String)])

/** publicKey: the Ed25519 public key (base64). secretKey: the 32-byte seed it comes from. */
export interface DeviceKeyPair { publicKey: string; secretKey: Buffer }
async function pairFromSeed(seed: Buffer): Promise<DeviceKeyPair> {
  const input = plain(seed), pair = (await loadSodium()).crypto_sign_seed_keypair(input)
  try { return { publicKey: b64(pair.publicKey), secretKey: Buffer.from(input) } }
  finally { pair.privateKey.fill(0); input.fill(0) }
}
/** A stored seed back into its pair (a server's delivery key). */
export const keyPairFromSeed = (seed: Buffer): Promise<DeviceKeyPair> => pairFromSeed(seed)
export async function createDeviceKeyPair(): Promise<DeviceKeyPair> {
  const seed = randomBytes(KEY_BYTES)
  try { return await pairFromSeed(seed) } finally { seed.fill(0) }
}
/** Runs `use` with the full Ed25519 secret key of a seed, wiped afterwards. */
async function withSigningKey<T>(seed: Buffer, use: (sodium: Awaited<ReturnType<typeof loadSodium>>, secret: Uint8Array) => T): Promise<T> {
  const sodium = await loadSodium(), input = plain(seed), pair = sodium.crypto_sign_seed_keypair(input)
  try { return use(sodium, pair.privateKey) } finally { pair.privateKey.fill(0); input.fill(0) }
}
function publicKeyBytes(value: string): Buffer {
  const bytes = decode(value)
  if (bytes.length !== KEY_BYTES) throw new VaultError('DATA_DAMAGED')
  return bytes
}
/** Only the holder of the matching secret key can open it. */
export async function sealTo(publicKey: string, message: Buffer): Promise<string> {
  const sodium = await loadSodium(), input = plain(message)
  try { return b64(sodium.crypto_box_seal(input, sodium.crypto_sign_ed25519_pk_to_curve25519(plain(publicKeyBytes(publicKey))))) }
  catch { throw new VaultError('DATA_DAMAGED') }
  finally { input.fill(0) }
}
export async function openSealed(pair: DeviceKeyPair, sealed: string): Promise<Buffer> {
  return withSigningKey(pair.secretKey, (sodium, signing) => {
    const secret = sodium.crypto_sign_ed25519_sk_to_curve25519(signing)
    try {
      const opened = sodium.crypto_box_seal_open(plain(decode(sealed)), sodium.crypto_sign_ed25519_pk_to_curve25519(plain(publicKeyBytes(pair.publicKey))), secret)
      try { return Buffer.from(opened) } finally { opened.fill(0) }
    } catch { throw new VaultError('DATA_DAMAGED') }
    finally { secret.fill(0) }
  })
}
export async function sign(pair: DeviceKeyPair, text: string): Promise<string> {
  return withSigningKey(pair.secretKey, (sodium, signing) => b64(sodium.crypto_sign_detached(plain(Buffer.from(text, 'utf8')), signing)))
}
export async function verifySignature(publicKey: string, text: string, signature: string): Promise<boolean> {
  try { return (await loadSodium()).crypto_sign_verify_detached(plain(decode(signature)), plain(Buffer.from(text, 'utf8')), plain(publicKeyBytes(publicKey))) }
  catch { return false }
}

export const randomKey = () => randomBytes(KEY_BYTES)
export const randomNonce = () => b64(randomBytes(NONCE_BYTES))
const digest = (...parts: (string | Buffer)[]) => {
  const hash = createHash('sha256')
  for (const part of parts) { const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part; hash.update(String(bytes.length)).update(':').update(bytes) }
  return hash.digest()
}
/** Step 1 of joining: the new device binds itself to its key and a nonce it reveals only after the approver's nonce. */
export function commitment(publicKey: string, deviceNonce: string): string {
  return digest('commit', publicKeyBytes(publicKey), decode(deviceNonce)).toString('hex')
}
export function verifyCommitment(publicKey: string, deviceNonce: string, commit: string): boolean {
  const expected = Buffer.from(commitment(publicKey, deviceNonce), 'hex'), actual = Buffer.from(commit, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
/** The 6 digits both screens show. Depends on randomness from both sides, so a swapped key cannot be ground to match;
 * covers both keys, so the new device also knows which device vouches for it. */
export function shortCode(publicKey: string, deviceNonce: string, approverNonce: string, approverKey: string): string {
  const value = digest('code', publicKeyBytes(publicKey), decode(deviceNonce), decode(approverNonce), publicKeyBytes(approverKey)).readBigUInt64BE(0) % 1_000_000n
  return value.toString().padStart(6, '0')
}

/** Compact one-string form of an AES-256-GCM box: base64(nonce‖tag‖ciphertext). */
export function boxed(key: Buffer, plaintext: Buffer, binding: string): string {
  const value = seal(key, plaintext, binding)
  return Buffer.concat([decode(value.nonce), decode(value.tag), decode(value.ciphertext)]).toString('base64')
}
export function unboxed(key: Buffer, value: string, binding: string): Buffer {
  const bytes = decode(value)
  if (bytes.length < 28) throw new VaultError('DATA_DAMAGED')
  return unseal(key, { nonce: b64(bytes.subarray(0, 12)), tag: b64(bytes.subarray(12, 28)), ciphertext: b64(bytes.subarray(28)) }, binding)
}

/** What a signed membership entry says about the vault key: a hash only, from which the key cannot be learned. */
export const keyHash = (owner: string, epoch: number, key: Buffer) => digest('vault-key', owner, String(epoch), key).toString('hex')

/** The vault key travels to a device together with its epoch, so a share cannot be replayed into another epoch. */
export async function sealVaultKey(publicKey: string, epoch: number, vaultKey: Buffer): Promise<string> {
  const message = Buffer.concat([Buffer.from(`${epoch}:`, 'utf8'), vaultKey])
  try { return await sealTo(publicKey, message) } finally { message.fill(0) }
}
export async function openVaultKey(pair: DeviceKeyPair, epoch: number, sealed: string): Promise<Buffer> {
  const message = await openSealed(pair, sealed), prefix = Buffer.from(`${epoch}:`, 'utf8')
  try {
    if (message.length !== prefix.length + KEY_BYTES || !message.subarray(0, prefix.length).equals(prefix)) throw new VaultError('DATA_DAMAGED')
    return Buffer.from(message.subarray(prefix.length))
  } finally { message.fill(0) }
}

/** Recovery code: 25 symbols of Crockford base32 (no I, L, O, U), about 125 bits, shown as 5 groups of 5. */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_LENGTH = 25
export function recoveryCode(): string {
  const symbols = Array.from({ length: RECOVERY_LENGTH }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)])
  return Array.from({ length: RECOVERY_LENGTH / 5 }, (_, group) => symbols.slice(group * 5, group * 5 + 5).join('')).join('-')
}
/** Accepts what a person types: any case, spaces or dashes, and O/I/L for 0/1. Undefined when it cannot be a code. */
export function normalizeRecoveryCode(input: string): string | undefined {
  const value = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return value.length === RECOVERY_LENGTH && [...value].every(symbol => RECOVERY_ALPHABET.includes(symbol)) ? value : undefined
}
/** The code is a device on paper: a key the vault key is sealed to (and that signs, when the code admits a device),
 * and a separate proof whose SHA-256 the cloud keeps to recognise the code. Neither reveals the other. */
export async function recoveryKeys(code: string): Promise<{ pair: DeviceKeyPair; proof: string; verifier: string }> {
  const normalized = normalizeRecoveryCode(code)
  if (!normalized) throw new VaultError('RECOVERY_INVALID')
  const seed = digest('recovery-seed', normalized), proof = digest('recovery-proof', normalized)
  try { return { pair: await pairFromSeed(seed), proof: proof.toString('base64'), verifier: createHash('sha256').update(proof).digest('hex') } }
  finally { seed.fill(0); proof.fill(0) }
}

