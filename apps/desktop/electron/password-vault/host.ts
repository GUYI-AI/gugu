import { VaultError, type VaultBrowserSink, type VaultDependencies } from './contracts'
import { captureBrowserSink } from './browser-use'
import { LocalPasswordVault } from './service'
import type { FixedOutcomeAuditPort } from '../session/main/core/browser/credential-settlement-contract'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'

export type VaultStorageDependencies = Omit<VaultDependencies, 'browser' | 'acquireFeatureGuard'>
export type VaultFeatureGuardProvider = NonNullable<VaultDependencies['acquireFeatureGuard']>
export type VaultStoragePorts = Readonly<{ vault: LocalPasswordVault; outcomeAudit: FixedOutcomeAuditPort }>

/** Fixed desktop-host construction only. No default readiness, registration, new custodian or lock state.
 * The native factory supplies macVaultKeyProtector(), trusted identities, the protected root and live readers.
 * Wire the returned audit port into the unique handoff registry before issuing any use capability.
 */
export function createVaultStorage(dependencies: VaultStorageDependencies, browser: VaultBrowserSink,
  acquireFeatureGuard: VaultFeatureGuardProvider): VaultStoragePorts {
  if (!PASSWORD_BETA_ENABLED) throw new VaultError('UNAVAILABLE')
  const keys = dependencies?.keys, sink = captureBrowserSink(browser)
  if (!dependencies || !keys || !sink || [dependencies.assertLocalPerson, dependencies.assertPrivateStorageReady,
    dependencies.invalidate, keys.verifyPerson, keys.wrap, keys.unwrap, acquireFeatureGuard].some(method => typeof method !== 'function')
    || dependencies.assertOwnedLocalAgent !== undefined && typeof dependencies.assertOwnedLocalAgent !== 'function'
    || dependencies.now !== undefined && typeof dependencies.now !== 'function') {
    throw new VaultError('UNAVAILABLE')
  }
  const fixed: VaultDependencies = Object.freeze({
    root: dependencies.root, accountId: dependencies.accountId, installationBinding: dependencies.installationBinding,
    assertLocalPerson: dependencies.assertLocalPerson.bind(dependencies),
    assertOwnedLocalAgent: dependencies.assertOwnedLocalAgent?.bind(dependencies),
    assertPrivateStorageReady: dependencies.assertPrivateStorageReady.bind(dependencies),
    invalidate: dependencies.invalidate.bind(dependencies), now: dependencies.now?.bind(dependencies),
    keys: Object.freeze({ verifyPerson: keys.verifyPerson.bind(keys), wrap: keys.wrap.bind(keys), unwrap: keys.unwrap.bind(keys) }),
    browser: sink, acquireFeatureGuard,
  })
  const vault = new LocalPasswordVault(fixed)
  return Object.freeze({ vault, outcomeAudit: vault.outcomeAudit })
}
