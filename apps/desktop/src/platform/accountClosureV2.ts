/** Independent V2 facade: no legacy receipt adapter or renderer-supplied proof.
 * Wire receipts, original SID and bearer tokens remain in native custody.
 */
export interface AccountClosureV2Policy {
  protocol_version: 2
  available: boolean
  deletion: 'immediate'
  credit_treatment: 'forfeit_remaining'
  consent_version: 'immediate-forfeit-v1'
  device_preparation_required: true
}
/** Local CAS revision is distinct from every server counter. */
export interface AccountClosureV2Handle {
  localOperationId: string
  nativeGeneration: string
  localRevision: number
}
export type AccountClosureV2ServerState = 'open' | 'confirming' | 'processing' | 'deleted' | 'closed_before_confirm'
export type AccountClosureV2Phase = 'captured' | 'registered' | 'challenge' | 'local-prepared' | 'prepared'
  | 'confirming' | 'processing' | 'deleted' | 'local-complete' | 'finalized' | 'cancel-pending' | 'cancelled'
export interface AccountClosureV2Snapshot {
  handle: AccountClosureV2Handle
  ownerId: string
  phase: AccountClosureV2Phase
  serverOperation: null | {
    operationId: string
    state: AccountClosureV2ServerState
    operationRevision: number
    challengeGeneration: number
    /** Authoritative request expiry, when present in original result. */
    challengeExpiresAt?: string | null
  }
  /** Neither nativeGeneration nor local/server operation revision. */
  serverPreparationGeneration: string | null
  /** Unknown preparation/confirmation retains custody and permits only recovery. */
  recoveryOnly: boolean
  /** A server 409/request_active leaves only original-result recovery. */
  confirmCancellationBlocked?: boolean
  pendingEffect: 'register' | 'challenge' | 'prepare_device' | 'confirm' | 'cancel' | null
  agentsPaused: boolean
  /** Fixed item names; never values, paths or credentials. */
  retainedUnattributed: readonly string[]
}
export interface AccountClosureV2Confirmation {
  code: string
  acknowledgeForfeit: true
}
/** Safe snapshots only. Native rejects foreign ownership and stale handles.
 * Policy failures reject; they are not available:false or a zero-credit fallback.
 * Balances use the existing authenticated billing interface, outside this policy.
 */
export interface AccountClosureV2Native {
  readPolicy(): Promise<AccountClosureV2Policy>
  /** Discover the original protected operation even after Auth deletion. */
  discover(): Promise<AccountClosureV2Snapshot | null>
  /** Persist owner/SID/operation/capability atomically before operation effects. */
  capture(): Promise<AccountClosureV2Snapshot>
  sendCode(handle: AccountClosureV2Handle): Promise<AccountClosureV2Snapshot>
  prepare(handle: AccountClosureV2Handle): Promise<AccountClosureV2Snapshot>
  confirm(handle: AccountClosureV2Handle, input: AccountClosureV2Confirmation): Promise<AccountClosureV2Snapshot>
  /** Original result only: never registers, resends, prepares or reconfirms. */
  recover(handle: AccountClosureV2Handle): Promise<AccountClosureV2Snapshot>
  /** Each explicit click sends at most one idempotent cancel, including an
   * unknown confirmation. No automatic loop; only a matching ACK unseals. */
  cancel(handle: AccountClosureV2Handle): Promise<AccountClosureV2Snapshot>
  /** Requires trusted deleted, scoped cleanup and renderer sign-out completion. */
  finalize(handle: AccountClosureV2Handle): Promise<AccountClosureV2Snapshot>
}

/** Fixed categories only; unrecognized native/transport details stay private. */
export const ACCOUNT_CLOSURE_V2_ERROR_CODES = [
  'closure_context_missing', 'closure_not_prepared', 'wrong_local_owner', 'scope_conflict', 'receipt_missing', 'invalid_scope', 'closure_storage_unavailable',
  'closure_busy', 'closure_unavailable', 'closure_not_available', 'closure_recovery_required', 'closure_not_complete',
  'unauthorized', 'invalid_request', 'verification_failed', 'rate_limited', 'operation_busy', 'request_active', 'state_conflict', 'not_found', 'preparation_unavailable', 'outcome_unknown', 'email_outcome_unknown',
] as const
export type AccountClosureV2ErrorCode = typeof ACCOUNT_CLOSURE_V2_ERROR_CODES[number]
export function isAccountClosureV2ErrorCode(value: unknown): value is AccountClosureV2ErrorCode {
  return typeof value === 'string' && (ACCOUNT_CLOSURE_V2_ERROR_CODES as readonly string[]).includes(value)
}
