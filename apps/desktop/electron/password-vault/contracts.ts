/** Main-process contracts only. Do not expose this service through Agent/MCP/device RPC. */
export type VaultCode = 'LOCKED' | 'UNAVAILABLE' | 'INVALID_INPUT' | 'NOT_INITIALIZED' | 'ALREADY_EXISTS'
  | 'DATA_MISSING' | 'DATA_DAMAGED' | 'WRONG_ACCOUNT' | 'WRONG_INSTALLATION' | 'CANNOT_UNLOCK'
  | 'RECOVERY_INVALID' | 'STALE_REFERENCE' | 'STORAGE_FAILED' | 'AUDIT_FAILED' | 'CANCELLED'
export class VaultError extends Error {
  constructor(readonly code: VaultCode) { super(code); this.name = 'VaultError' }
}
export interface CredentialReference { id: string; version: number; epoch: string }
export interface CredentialGrant { subject: string; level: 'read' | 'write' }
/** Values marked non-secret are included (`account`, a field's `value`); secret ones never are. */
export interface CredentialSummary { reference: CredentialReference; name: string; origin: string; account?: string; maskedAccount: string; accountSecret: boolean
  hasPassword: boolean; fields: { id: string; name: string; secret: boolean; value?: string }[]; grants: CredentialGrant[]; sites: string[] }
/** Person-only plaintext, returned after local system verification. Never an Agent result. */
export interface CredentialSecrets { account: string; password: string; fields: { id: string; name: string; value: string }[] }
export interface CredentialInput { origin: string; name?: string; account: string; accountSecret?: boolean; password: string
  fields?: { id: string; name: string; value: string; secret?: boolean }[]; sites?: string[] }
export type LockReason = 'explicit' | 'os-lock' | 'suspend' | 'logout' | 'account-switch' | 'app-exit' | 'failure'
export interface Invalidation { epoch: string; reason: LockReason | 'edit' | 'delete' | 'recovery'; credentialId?: string }
export interface VaultState { status: 'locked' | 'unlocked' | 'unavailable'; epoch: string; reason?: VaultCode }
export interface AuditInput {
  id: string
  action: 'pre-submit' | 'setup' | 'recovery' | 'unlock' | 'lock' | 'add' | 'edit' | 'delete' | 'request' | 'decision' | 'use' | 'invalidate' | 'clear' | 'grant' | 'reveal'
  loginSurfaceId?: string; agentId?: string; sessionId?: string; requestId?: string; useId?: string
  credential?: { id: string; version: number }; origin?: string
  decision?: 'allow-once' | 'reject' | 'cancel' | 'expire'
  source: 'local-person' | 'policy' | 'browser' | 'lifecycle'
  outcome: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'invalidated' | 'completed' | 'failed' | 'uncertain' | 'submitted_unconfirmed' | 'login_confirmed' | 'person_interaction_required'
}
export interface AuditRecord extends AuditInput { id: string; at: string; accountId: string }
export type AuditReceipt = { status: 'recorded'; recordId: string } | {
  status: 'unavailable' | 'uncertain'; code: 'AUDIT_FAILED'; retry: false; retainIsolatedLogin: boolean
}
/** Implemented by the trusted local host, never from tool arguments or a claimed principal. */
export interface VaultKeyProtector {
  verifyPerson(): Promise<void>
  wrap(key: Buffer, binding: string): Promise<string>
  unwrap(wrapped: string, binding: string): Promise<Buffer>
}
export interface VaultDependencies {
  root: string
  /** Stable per userData installation; do not use a cloud account/device token. */
  installationBinding: string
  accountId: string
  assertLocalPerson(context: object): void
  assertOwnedLocalAgent?(context: object): void
  /** Check the actual native-file exclusion before every access, including before mkdir. */
  assertPrivateStorageReady(): Promise<void>
  /** Fixed live readiness adapter. Missing/void/async synchronous guards fail closed; this grants no approval. */
  acquireFeatureGuard?(operation: 'save' | 'use', signal: AbortSignal): Promise<VaultFeatureGuard>
  keys: VaultKeyProtector
  browser?: VaultBrowserSink
  /** Synchronous revocation first, then wait for browser cleanup before edit/delete success. */
  invalidate(event: Invalidation): Promise<void>
  /** Cross-device sync (SYNC.md). Absent = this device keeps a local-only vault. */
  sync?: { publish(change: import('./management').SyncChange): Promise<void> }
  now?: () => number
}
import type { PasswordAvailability } from '../permissions/password-readiness'
import type { LivePasswordFact } from '../permissions/password-facts'
export type VaultFeatureGuard = Extract<PasswordAvailability, { status: 'ready' }>
/** Host-only identity source. Pending setup may qualify save, never use. It contains no key/material. */
export type VaultInstallationIdentity = LivePasswordFact<Readonly<{ installationId: string; status: 'pending_setup' | 'persisted' }>>

export type { VaultUseCapability, CredentialUseLease as VaultUseControl } from '../session/main/core/browser/credential-use-contract'
import type { VaultUseCapability, CredentialUseBinding, CredentialUseLease, AuditedCredentialUseLease, CredentialUseCleanup, CredentialLoginOutcome } from '../session/main/core/browser/credential-use-contract'
import type { FixedVaultUseSettlementSink } from '../session/main/core/browser/credential-settlement-contract'
export type VaultUseBinding = CredentialUseBinding
export type BrowserOutcome = CredentialLoginOutcome
export type VaultSinkControl = AuditedCredentialUseLease
/** One value of a credential, by what it is: the account, the password, a field (by id), or the current one-time code
 * computed from a field holding a TOTP seed. */
/** `typed`: a value nothing stores; the person (or the Agent, for one it already knows) supplies it in `typed`. */
export type VaultFillValue = Readonly<{ kind: 'account' } | { kind: 'password' } | { kind: 'field'; id: string } | { kind: 'code'; id: string } | { kind: 'typed' }>
/**
 * What a use releases, in the order of the page's targets. `elsewhere`: the person approved this use on a website that
 * is neither the credential's own nor one of its sites. Built by the trusted host from the approved request only.
 */
/** `typed[i]`: what the person typed on the card (or the Agent already knew) for value i, used instead of the stored one
 * for this use only. `transient`: no saved credential at all; every value is typed, and nothing is looked up. */
export type VaultFillPlan = Readonly<{ values: readonly VaultFillValue[]; elsewhere: boolean; typed?: readonly (string | undefined)[]; transient?: boolean }>
export interface VaultBrowserSink extends FixedVaultUseSettlementSink {
  claimCredentialSink(capability: VaultUseCapability, binding: VaultUseBinding): CredentialUseLease
  /** Fixed at trusted host construction, never supplied by an Agent or per-call callback. */
  fillAndSubmit(binding: VaultUseBinding, secrets: { values: readonly Buffer[] }, control: VaultSinkControl): Promise<BrowserOutcome>
  /** Cleanup proves clearing only and MUST NOT hand back the isolated surface; only the coordinator can finalize handoff. */
  cleanup(useRef: string): Promise<CredentialUseCleanup>
}
/** Login outcome only. A false retention flag is NOT handback authority; the coordinator checks the complete B state. */
export interface CredentialUseResult { status: BrowserOutcome | 'unavailable'; retry: false; retainIsolatedLogin: boolean }
