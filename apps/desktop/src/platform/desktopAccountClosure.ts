import type { AccountClosureErrorCode, AccountClosureNative, AccountClosureResult, AccountClosureScope } from './accountClosure'

const failure = (code: AccountClosureErrorCode): never => { throw Object.assign(new Error(code), { code }) }
async function invoke(type: string, scope: AccountClosureScope, receipt?: string): Promise<unknown> {
  const api = window.electronAPI
  if (!api) return failure('closure_storage_unavailable')
  let reply: unknown
  try { reply = await api.invoke('account-closure:local', { type, scope, ...(receipt === undefined ? {} : { receipt }) }) }
  catch { return failure('closure_storage_unavailable') }
  if (!reply || typeof reply !== 'object' || !('ok' in reply)) return failure('closure_storage_unavailable')
  if (reply.ok !== true) {
    const code = 'code' in reply ? reply.code : undefined
    const known: readonly string[] = ['closure_context_missing', 'closure_not_prepared', 'wrong_local_owner', 'scope_conflict', 'receipt_missing', 'invalid_scope', 'closure_storage_unavailable']
    return failure(typeof code === 'string' && known.includes(code) ? code as AccountClosureErrorCode : 'closure_storage_unavailable')
  }
  return 'value' in reply ? reply.value : undefined
}
const done = async (type: string, scope: AccountClosureScope, receipt?: string) => { await invoke(type, scope, receipt) }
export const nativeDesktopAccountClosure: AccountClosureNative = {
  receipt: {
    put: (scope, receipt) => done('put', scope, receipt),
    async get(scope) {
      const result = await invoke('get', scope)
      if (result !== null && typeof result !== 'string') return failure('closure_storage_unavailable')
      return result
    },
    remove: scope => done('remove', scope),
  },
  async eraseLocal(scope) {
    const result = await invoke('eraseLocal', scope) as Partial<AccountClosureResult> | null
    if (!result || (result.status !== 'complete' && result.status !== 'pending') || !Array.isArray(result.retainedUnattributed)
      || !result.retainedUnattributed.every(name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(name))) return failure('closure_storage_unavailable')
    return result as AccountClosureResult
  },
}
/** Private composition hooks; no preparation assertion from renderer data. */
export const desktopClosurePreparation = {
  async prepare(scope: AccountClosureScope) {
    const result = await invoke('prepare', scope) as { prepared?: unknown } | null
    if (result?.prepared !== true) return failure('closure_not_prepared')
  },
  async cancel(scope: AccountClosureScope) {
    const result = await invoke('cancel', scope) as { cancelled?: unknown } | null
    if (result?.cancelled !== true) return failure('closure_not_prepared')
  },
}
