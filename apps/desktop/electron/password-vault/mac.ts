import { app, safeStorage } from 'electron'
import { VaultError, type VaultKeyProtector } from './contracts'
import { unwrapWithSafeStorage, wrapWithSafeStorage } from './key-wrap'

/** The desktop Mac's keys. A gugu server uses serverVaultKeyProtector (electron/server/password-vault-keys.ts) instead:
 * since owner decision 2B (11-11) a server holds keys, but only for the passwords authorized to Agents on it.
 * `verifyOwner` is the system owner check (Touch ID, or this Mac's login password when Touch ID is unavailable),
 * used only before revealing plaintext; opening the vault itself needs no person step. */
export function macVaultKeyProtector(verifyOwner: (reason: string) => Promise<void>): VaultKeyProtector {
  function available(): void {
    if (process.platform !== 'darwin' || process.type !== 'browser' || !app.isReady() || !safeStorage.isEncryptionAvailable()) throw new VaultError('UNAVAILABLE')
  }
  return {
    async verifyPerson() {
      available()
      try { await verifyOwner('查看已保存的密码') }
      catch { throw new VaultError('CANNOT_UNLOCK') }
    },
    async wrap(key, binding) { available(); return wrapWithSafeStorage(key, binding) },
    async unwrap(wrapped, binding) { available(); return unwrapWithSafeStorage(wrapped, binding) },
  }
}
