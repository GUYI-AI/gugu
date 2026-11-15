/** Native rejections are failures, not missing values or successful empty cleanup.
 * Missing put rejects get/remove/erase with closure_context_missing. Only a
 * captured scope whose receipt was removed returns null from get.
 * closure_not_prepared means the pre-confirm phone stop/retirement is incomplete;
 * it is a defensive refusal, not a request to reorder the controller's flow.
 * Native/platform-specific storage failures may additionally be surfaced by
 * the bridge; consumers must fail closed on any unrecognized code.
 */
export type AccountClosureErrorCode =
  | 'closure_context_missing'
  | 'closure_not_prepared'
  | 'wrong_local_owner'
  | 'scope_conflict'
  | 'receipt_missing'
  | 'invalid_scope'
  | 'closure_storage_unavailable'

/** Opaque receipt bytes must never enter logs, URLs, telemetry or screenshots. */
export interface AccountClosureScope {
  ownerId: string
  localOperationId: string
}
export interface AccountClosureResult {
  status: 'complete' | 'pending'
  /** Fixed item names only; no values, receipts or account identifiers. Always present. */
  retainedUnattributed: string[]
}
export interface AccountClosureNative {
  receipt: {
    put(scope: AccountClosureScope, receipt: string): Promise<void>
    get(scope: AccountClosureScope): Promise<string | null>
    remove(scope: AccountClosureScope): Promise<void>
  }
  eraseLocal(scope: AccountClosureScope): Promise<AccountClosureResult>
}

const unsupported = async (): Promise<never> => {
  throw new Error('Native account closure storage is unsupported on this platform')
}
/** No plaintext/localStorage fallback, including on Android until its adapter lands. */
export const unsupportedAccountClosure: AccountClosureNative = {
  receipt: { put: unsupported, get: unsupported, remove: unsupported },
  eraseLocal: unsupported,
}
