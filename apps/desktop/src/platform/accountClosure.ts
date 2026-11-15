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
