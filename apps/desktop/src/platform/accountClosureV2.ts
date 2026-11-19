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
  }
  /** Neither nativeGeneration nor local/server operation revision. */
  serverPreparationGeneration: string | null
  /** Unknown preparation/confirmation retains custody and permits only recovery. */
  recoveryOnly: boolean
  pendingEffect: 'challenge' | 'prepare_device' | 'confirm' | 'cancel' | null
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
  /** Only a trusted matching-generation ACK permits native unsealing. */
  cancel(handle: AccountClosureV2Handle): Promise<AccountClosureV2Snapshot>
  /** Requires trusted deleted, scoped cleanup and renderer sign-out completion. */
  finalize(handle: AccountClosureV2Handle): Promise<AccountClosureV2Snapshot>
}
