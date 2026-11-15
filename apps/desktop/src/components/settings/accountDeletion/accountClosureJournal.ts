import type { AccountClosureErrorCode, AccountClosureScope } from '@/platform/accountClosure'
import type { AccountClosureJournal } from './accountClosureLocalCleanup'

export type AccountClosureMetadataStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const prefix = 'gugu.account-closure.scope.v1:'
const ownerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const fail = (code: AccountClosureErrorCode): never => { throw Object.assign(new Error(code), { code }) }
function scope(value: unknown, ownerId: string): AccountClosureScope {
  if (!ownerPattern.test(ownerId) || !value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_scope')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 2 || row.ownerId !== ownerId || typeof row.localOperationId !== 'string'
    || !row.localOperationId || new TextEncoder().encode(row.localOperationId).length > 256) return fail('invalid_scope')
  return Object.freeze({ ownerId, localOperationId: row.localOperationId })
}

/** Metadata only: receipts stay native. Corrupt/unavailable storage must not
 * lose the operation ID and silently permit resubmission after a restart.
 */
export function createAccountClosureJournal(storage: AccountClosureMetadataStorage): AccountClosureJournal {
  function read(ownerId: string): AccountClosureScope | null {
    if (!ownerPattern.test(ownerId)) return fail('invalid_scope')
    let raw: string | null
    try { raw = storage.getItem(prefix + ownerId) } catch { return fail('closure_storage_unavailable') }
    if (raw === null) return null
    let value: unknown
    try { value = JSON.parse(raw) } catch { return fail('invalid_scope') }
    return scope(value, ownerId)
  }
  return {
    async read(ownerId) { return read(ownerId) },
    async write(value) {
      const next = scope({ ownerId: value.ownerId, localOperationId: value.localOperationId }, value.ownerId)
      const current = read(next.ownerId)
      if (current && current.localOperationId !== next.localOperationId) return fail('scope_conflict')
      try { storage.setItem(prefix + next.ownerId, JSON.stringify(next)) } catch { return fail('closure_storage_unavailable') }
    },
    async remove(value) {
      const wanted = scope({ ownerId: value.ownerId, localOperationId: value.localOperationId }, value.ownerId)
      const current = read(wanted.ownerId)
      if (current && current.localOperationId !== wanted.localOperationId) return fail('scope_conflict')
      try { storage.removeItem(prefix + wanted.ownerId) } catch { return fail('closure_storage_unavailable') }
    },
  }
}
