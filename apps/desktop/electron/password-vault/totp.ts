import { createHmac } from 'node:crypto'
import { VaultError } from './contracts'

type Algorithm = 'sha1' | 'sha256' | 'sha512'
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new VaultError('UNAVAILABLE')
  let bits = 0, value = 0
  const out: number[] = []
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char); bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}

/** A TOTP seed as people paste it: an otpauth:// URI (from a QR code) or the bare base32 secret. RFC 6238. */
function seed(text: string): { key: Buffer; algorithm: Algorithm; digits: number; period: number } {
  const trimmed = text.trim()
  if (!/^otpauth:\/\//i.test(trimmed)) return { key: base32(trimmed), algorithm: 'sha1', digits: 6, period: 30 }
  let url: URL
  try { url = new URL(trimmed) } catch { throw new VaultError('UNAVAILABLE') }
  if (url.hostname.toLowerCase() !== 'totp') throw new VaultError('UNAVAILABLE')
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toLowerCase()
  const digits = Number(url.searchParams.get('digits') ?? 6), period = Number(url.searchParams.get('period') ?? 30)
  if (!['sha1', 'sha256', 'sha512'].includes(algorithm) || ![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 1 || period > 300) throw new VaultError('UNAVAILABLE')
  return { key: base32(url.searchParams.get('secret') ?? ''), algorithm: algorithm as Algorithm, digits, period }
}

/** The current code for a stored seed. The seed never leaves this function; the key buffer is cleared. */
export function totpCode(text: string, now = Date.now()): string {
  const { key, algorithm, digits, period } = seed(text)
  try {
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)))
    const hash = createHmac(algorithm, key).update(counter).digest()
    const offset = hash[hash.length - 1]! & 0x0f
    const binary = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
    hash.fill(0)
    return String(binary).padStart(digits, '0')
  } finally { key.fill(0) }
}
