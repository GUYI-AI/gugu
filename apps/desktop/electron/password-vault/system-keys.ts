import { app, safeStorage } from 'electron'
import { timingSafeEqual } from 'node:crypto'
import { VaultError, type VaultKeyProtector } from './contracts'
import { decode } from './crypto'

/**
 * The vault key, wrapped by the operating system's own protection through Electron safeStorage: the macOS Keychain, DPAPI
 * on Windows (bound to the signed-in Windows user), the Secret Service (GNOME Keyring / KWallet) on Linux. Opening the
 * vault needs no person step anywhere; that is the system login. Import only in the real desktop main; headless/server
 * shims must never supply vault keys.
 *
 * `verifyOwner` is the system owner check before revealing plaintext, and only macOS has one we use (Touch ID, or this
 * Mac's login password when Touch ID is unavailable). Elsewhere plaintext is never revealed: saving, editing and using
 * are unaffected.
 */
export function systemVaultKeyProtector(verifyOwner: ((reason: string) => Promise<void>) | null): VaultKeyProtector {
  function available(): void {
    if (!['darwin', 'win32', 'linux'].includes(process.platform) || process.type !== 'browser' || !app.isReady()) throw new VaultError('UNAVAILABLE')
    if (!safeStorage.isEncryptionAvailable()) throw new VaultError('SYSTEM_STORAGE_UNAVAILABLE')
    // Linux without a keyring falls back to a key everyone on this account can read: not protection, so refuse it
    // (the same line encrypted-app-secrets-store.ts draws for every other secret of the app).
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new VaultError('SYSTEM_STORAGE_UNAVAILABLE')
  }
  return {
    async verifyPerson() {
      available()
      if (process.platform !== 'darwin' || !verifyOwner) throw new VaultError('UNAVAILABLE')
      try { await verifyOwner('查看已保存的密码') }
      catch { throw new VaultError('CANNOT_UNLOCK') }
    },
    async wrap(key, binding) {
      available()
      try { return safeStorage.encryptString(JSON.stringify({ binding, key: key.toString('base64') })).toString('base64') }
      catch { throw new VaultError('CANNOT_UNLOCK') }
    },
    async unwrap(wrapped, binding) {
      available()
      try {
        const value = JSON.parse(safeStorage.decryptString(decode(wrapped))) as { binding: string; key: string }
        const expected = Buffer.from(binding), actual = Buffer.from(value.binding)
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error()
        const key = decode(value.key)
        if (key.length !== 32) { key.fill(0); throw new Error() }
        return key
      } catch { throw new VaultError('CANNOT_UNLOCK') }
    },
  }
}
