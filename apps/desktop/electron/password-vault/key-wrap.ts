import { safeStorage } from 'electron'
import { timingSafeEqual } from 'node:crypto'
import { VaultError } from './contracts'
import { decode } from './crypto'

/** A 32-byte key wrapped by the platform's safeStorage, bound to its use. Shared by the Mac (Keychain) and the gugu
 * server (its own key file); callers check the platform before calling. */
export function wrapWithSafeStorage(key: Buffer, binding: string): string {
  try { return safeStorage.encryptString(JSON.stringify({ binding, key: key.toString('base64') })).toString('base64') }
  catch { throw new VaultError('CANNOT_UNLOCK') }
}
export function unwrapWithSafeStorage(wrapped: string, binding: string): Buffer {
  try {
    const value = JSON.parse(safeStorage.decryptString(decode(wrapped))) as { binding: string; key: string }
    const expected = Buffer.from(binding), actual = Buffer.from(value.binding)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error()
    const key = decode(value.key)
    if (key.length !== 32) { key.fill(0); throw new Error() }
    return key
  } catch { throw new VaultError('CANNOT_UNLOCK') }
}
