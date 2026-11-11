import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { VaultError } from './contracts'
import { decode, seal, unseal } from './crypto'

/**
 * Cryptography for end-to-end vault sync (SYNC.md). Symmetric parts reuse the vault's AES-256-GCM (`crypto.ts`);
 * device key pairs and sealed shares use libsodium's X25519 sealed boxes. Nothing here touches the network or disk.
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

export interface DeviceKeyPair { publicKey: string; secretKey: Buffer }
export async function createDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = (await loadSodium()).crypto_box_keypair()
  try { return { publicKey: b64(pair.publicKey), secretKey: Buffer.from(pair.privateKey) } }
  finally { pair.privateKey.fill(0) }
}
function publicKeyBytes(value: string): Buffer {
  const bytes = decode(value)
  if (bytes.length !== KEY_BYTES) throw new VaultError('DATA_DAMAGED')
  return bytes
}
/** Only the holder of the matching secret key can open it. */
export async function sealTo(publicKey: string, message: Buffer): Promise<string> {
  const input = plain(message)
  try { return b64((await loadSodium()).crypto_box_seal(input, plain(publicKeyBytes(publicKey)))) } finally { input.fill(0) }
}
export async function openSealed(pair: DeviceKeyPair, sealed: string): Promise<Buffer> {
  const sodium = await loadSodium()
  const secret = plain(pair.secretKey)
  try {
    const opened = sodium.crypto_box_seal_open(plain(decode(sealed)), plain(publicKeyBytes(pair.publicKey)), secret)
    try { return Buffer.from(opened) } finally { opened.fill(0) }
  } catch { throw new VaultError('DATA_DAMAGED') }
  finally { secret.fill(0) }
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
/** The 6 digits both screens show. Depends on randomness from both sides, so a swapped key cannot be ground to match. */
export function shortCode(publicKey: string, deviceNonce: string, approverNonce: string): string {
  const value = digest('code', publicKeyBytes(publicKey), decode(deviceNonce), decode(approverNonce)).readBigUInt64BE(0) % 1_000_000n
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
