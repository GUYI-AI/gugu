/** Ephemeral save-card keys. Only ciphertext crosses the device relay; keys live for the pending request. */
const sodium = async () => { const { default: value } = await import('libsodium-wrappers'); await value.ready; return value }
export interface PasswordCardKey { publicKey: string; privateKey: Uint8Array }
export async function createPasswordCardKey(): Promise<PasswordCardKey> {
  const value = await sodium(), pair = value.crypto_box_keypair()
  return { publicKey: value.to_base64(pair.publicKey, value.base64_variants.ORIGINAL), privateKey: pair.privateKey }
}
export async function sealPasswordCard(publicKey: string, payload: unknown): Promise<string> {
  const value = await sodium(), plain = value.from_string(JSON.stringify(payload))
  try { return value.to_base64(value.crypto_box_seal(plain, value.from_base64(publicKey, value.base64_variants.ORIGINAL)), value.base64_variants.ORIGINAL) }
  finally { plain.fill(0) }
}
export async function openPasswordCard(key: PasswordCardKey, ciphertext: string): Promise<unknown> {
  const value = await sodium(), plain = value.crypto_box_seal_open(value.from_base64(ciphertext, value.base64_variants.ORIGINAL),
    value.from_base64(key.publicKey, value.base64_variants.ORIGINAL), key.privateKey)
  try { return JSON.parse(value.to_string(plain)) } finally { plain.fill(0) }
}
export const PASSWORD_SAVE_CARD_RPC = 'password.save-card'
