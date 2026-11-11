import { safeStorage } from 'electron'
import { VaultError, type VaultKeyProtector } from '../password-vault/contracts'
import { unwrapWithSafeStorage, wrapWithSafeStorage } from '../password-vault/key-wrap'

/**
 * Vault keys on a gugu server (owner decision 2B, 11-11): a server holds keys only for the passwords authorized to
 * Agents on it, wrapped by the server's own key file (the shim's safeStorage under the 0700 server home, the same
 * protection as its sign-in session). Nobody sits at a server, so the person-only reveal is refused here.
 * Limit, stated plainly: Agents on this server run as the same system user, so one that can run commands could read
 * what this server holds; that is why the server holds as little as possible.
 */
export function serverVaultKeyProtector(): VaultKeyProtector {
  function available(): void {
    if (process.env.GUGU_SERVER_MODE !== '1' || !safeStorage.isEncryptionAvailable()
      // The server shim reports its own backend name, outside Electron's Linux backend list.
      || (safeStorage.getSelectedStorageBackend?.() as string | undefined) !== 'gugu_session_host_file_key') throw new VaultError('UNAVAILABLE')
  }
  return {
    async verifyPerson() { throw new VaultError('CANNOT_UNLOCK') },
    async wrap(key, binding) { available(); return wrapWithSafeStorage(key, binding) },
    async unwrap(wrapped, binding) { available(); return unwrapWithSafeStorage(wrapped, binding) },
  }
}
