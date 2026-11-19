import { isAccountClosureV2ErrorCode, type AccountClosureV2Native } from './accountClosureV2'
const failure = (code: string): never => { throw Object.assign(new Error(code), { code }) }
async function invoke(type: string, handle?: unknown, confirmation?: unknown): Promise<unknown> {
  const api = window.electronAPI
  if (!api) return failure('closure_unavailable')
  let reply: unknown
  try { reply = await api.invoke('account-closure:v2', { type, ...(handle === undefined ? {} : { handle }), ...(confirmation === undefined ? {} : { confirmation }) }) }
  catch { return failure('closure_unavailable') }
  if (!reply || typeof reply !== 'object' || !('ok' in reply)) return failure('closure_unavailable')
  if (reply.ok !== true) return failure('code' in reply && isAccountClosureV2ErrorCode(reply.code) ? reply.code : 'closure_unavailable')
  if (!('value' in reply)) return failure('closure_unavailable')
  return reply.value
}
/** Independent facade: no browser journal, token, receipt or legacy adapter. */
export const nativeDesktopAccountClosureV2: AccountClosureV2Native = {
  readPolicy: () => invoke('readPolicy') as ReturnType<AccountClosureV2Native['readPolicy']>,
  discover: () => invoke('discover') as ReturnType<AccountClosureV2Native['discover']>,
  capture: () => invoke('capture') as ReturnType<AccountClosureV2Native['capture']>,
  sendCode: h => invoke('sendCode', h) as ReturnType<AccountClosureV2Native['sendCode']>,
  prepare: h => invoke('prepare', h) as ReturnType<AccountClosureV2Native['prepare']>,
  confirm: (h, c) => invoke('confirm', h, c) as ReturnType<AccountClosureV2Native['confirm']>,
  recover: h => invoke('recover', h) as ReturnType<AccountClosureV2Native['recover']>,
  cancel: h => invoke('cancel', h) as ReturnType<AccountClosureV2Native['cancel']>,
  finalize: h => invoke('finalize', h) as ReturnType<AccountClosureV2Native['finalize']>,
}
export const unsupportedAccountClosureV2: AccountClosureV2Native = {
  readPolicy: async () => failure('closure_unavailable'), discover: async () => failure('closure_unavailable'),
  capture: async () => failure('closure_unavailable'), sendCode: async () => failure('closure_unavailable'),
  prepare: async () => failure('closure_unavailable'), confirm: async () => failure('closure_unavailable'),
  recover: async () => failure('closure_unavailable'), cancel: async () => failure('closure_unavailable'),
  finalize: async () => failure('closure_unavailable'),
}

/** Invoke only from an explicit user resume action, never reconciliation. */
export async function resumeDesktopAgentsAfterAccountClosure(): Promise<void> {
  const api = window.electronAPI
  if (!api) return failure('closure_unavailable')
  let reply: unknown
  try { reply = await api.invoke('account-closure:resume-paused') } catch { return failure('closure_unavailable') }
  if (!reply || typeof reply !== 'object' || !('ok' in reply)) return failure('closure_unavailable')
  if (reply.ok !== true) return failure('code' in reply && isAccountClosureV2ErrorCode(reply.code) ? reply.code : 'closure_unavailable')
}
