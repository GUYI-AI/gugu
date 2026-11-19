import { isAccountClosureV2ErrorCode, type AccountClosureV2ErrorCode, type AccountClosureV2Policy, type AccountClosureV2ServerState } from '../../src/platform/accountClosureV2'

export interface ClosureV2Auth { ownerId: string; sessionId: string; accessToken: string }
export interface ClosureV2Binding {
  ownerId: string; sessionId: string; localOperationId: string; receipt: string
  serverOperationId: string | null; nativeGeneration: string; serverGeneration: string | null
  challengeGeneration: number; confirmationId: string | null
}
export interface ClosureV2Operation {
  id: string; state: AccountClosureV2ServerState; revision: number; challengeGeneration: number; requestId: string | null
  canReleasePreparation: boolean | null
  requestState: string | null
  request: null | { id: string; state: string; expiresAt: string; lastError: string | null; canRetry: boolean }
  confirmation: null | { id: string; state: string; challengeGeneration: number; errorCode: string | null }
}
export interface ClosureV2Reply {
  operation: ClosureV2Operation
  preparation: null | { nativeGeneration: string; serverGeneration: string | null; prepared: boolean | null; cancelled: boolean | null }
}
export class ClosureV2HttpFailure extends Error {
  constructor(readonly code: AccountClosureV2ErrorCode, readonly outcomeUnknown = false, readonly rejection: ClosureV2Reply | null = null) { super(code) }
}
export type ClosureV2Route = 'register' | 'challenge' | 'prepare_device' | 'read_preparation' | 'cancel_preparation' | 'confirm' | 'result' | 'cancel'
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x)
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const states = new Set(['open', 'confirming', 'processing', 'deleted', 'closed_before_confirm'])
const invalid = (): never => { throw new ClosureV2HttpFailure('closure_unavailable', true) }
const optionalBoolean = (x: unknown): boolean | null => x === undefined ? null : typeof x === 'boolean' ? x : invalid()
export function parseClosureV2Reply(value: unknown): ClosureV2Reply {
  if (!object(value) || !object(value.operation)) return invalid()
  const o = value.operation
  if (!uuid(o.operation_id) || !states.has(o.state as string) || !count(o.revision) || !count(o.challenge_generation)
      || o.challenge_generation > 2147483647 || (o.request_id !== null && !uuid(o.request_id)) || o.can_retry !== false) return invalid()
  let requestState: string | null = null
  let request: ClosureV2Operation['request'] = null
  if (o.request !== undefined && o.request !== null) {
    if (!object(o.request) || !['sending', 'challenge', 'verifying', 'processing', 'retry_wait', 'deleted', 'failed', 'expired'].includes(o.request.state as string)) return invalid()
    requestState = o.request.state as string
    const q = o.request
    if (uuid(q.request_id) && typeof q.expires_at === 'string' && Number.isFinite(Date.parse(q.expires_at))
      && (q.last_error === null || typeof q.last_error === 'string' && q.last_error.length <= 64) && typeof q.can_retry === 'boolean') {
      request = { id: q.request_id, state: requestState, expiresAt: q.expires_at, lastError: q.last_error, canRetry: q.can_retry }
    }
  }
  let confirmation: ClosureV2Operation['confirmation'] = null
  if (o.confirmation !== undefined && o.confirmation !== null) {
    const c = o.confirmation
    if (!object(c) || !uuid(c.confirmation_id) || !['verifying', 'rejected', 'processing', 'deleted'].includes(c.state as string)
        || !count(c.challenge_generation) || (c.error_code !== null && typeof c.error_code !== 'string')) return invalid()
    confirmation = { id: c.confirmation_id, state: c.state as string, challengeGeneration: c.challenge_generation, errorCode: c.error_code as string | null }
  }
  let preparation: ClosureV2Reply['preparation'] = null
  if (value.preparation !== undefined) {
    const p = value.preparation
    if (!object(p) || !uuid(p.native_generation) || (p.server_generation !== null && !uuid(p.server_generation))) return invalid()
    preparation = { nativeGeneration: p.native_generation, serverGeneration: p.server_generation, prepared: optionalBoolean(p.prepared), cancelled: optionalBoolean(p.cancelled) }
    if (preparation.prepared === true && preparation.cancelled === true) return invalid()
  }
  return { operation: { id: o.operation_id, state: o.state as AccountClosureV2ServerState, revision: o.revision,
    challengeGeneration: o.challenge_generation, requestId: o.request_id, canReleasePreparation: optionalBoolean(o.can_release_preparation), requestState, request, confirmation }, preparation }
}
export function isMatchingClosureRejection(reply: ClosureV2Reply, binding: ClosureV2Binding): boolean {
  const o = reply.operation, c = o.confirmation
  return binding.serverOperationId !== null && o.id === binding.serverOperationId && o.state === 'open'
    && !!c && c.id === binding.confirmationId && c.challengeGeneration === binding.challengeGeneration && c.state === 'rejected'
}

async function jsonBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) return invalid()
  const parts: Uint8Array[] = []; let bytes = 0
  for (;;) {
    const item = await reader.read(); if (item.done) break
    bytes += item.value.length
    if (bytes > 16384) { await reader.cancel(); return invalid() }
    parts.push(item.value)
  }
  const all = new Uint8Array(bytes); let offset = 0
  for (const part of parts) { all.set(part, offset); offset += part.length }
  try { return JSON.parse(new TextDecoder().decode(all)) }
  catch { return invalid() }
}
const fields: Record<ClosureV2Route, readonly string[]> = {
  register: ['consent_version'], challenge: ['consent_version', 'generation'],
  prepare_device: ['device_id', 'native_generation'], read_preparation: ['native_generation', 'server_generation'], cancel_preparation: ['native_generation', 'server_generation'],
  confirm: ['consent_version', 'generation', 'confirmation_id', 'native_generation', 'server_generation', 'code', 'acknowledge_forfeit'],
  result: [], cancel: ['native_generation', 'server_generation'],
}
/** Fixed build target only. No renderer URL, redirects, retries or legacy route. */
export function createClosureV2Http(input: { baseUrl: string; anonKey: string; fetch?: typeof fetch }) {
  let base: URL
  try { base = new URL(input.baseUrl) } catch { throw new ClosureV2HttpFailure('closure_unavailable') }
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))
      || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !input.anonKey) throw new ClosureV2HttpFailure('closure_unavailable')
  if (!input.anonKey.startsWith('sb_publishable_')) {
    try { if (JSON.parse(Buffer.from(input.anonKey.split('.')[1] ?? '', 'base64url').toString('utf8')).role !== 'anon') throw Error() }
    catch { throw new ClosureV2HttpFailure('closure_unavailable') }
  }
  const request = input.fetch ?? fetch
  const endpoint = (route: string) => new URL('/functions/v1/account-deletion/v2/' + route, base).href
  const authHeaders = (auth: ClosureV2Auth) => {
    if (!uuid(auth.ownerId) || !uuid(auth.sessionId) || !auth.accessToken || auth.accessToken.length > 8192 || /\s/.test(auth.accessToken)) throw new ClosureV2HttpFailure('unauthorized')
    try {
      const claims = JSON.parse(Buffer.from(auth.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
      if (claims.sub !== auth.ownerId || claims.session_id !== auth.sessionId || claims.role !== 'authenticated') throw Error()
    } catch { throw new ClosureV2HttpFailure('unauthorized') }
    return { apikey: input.anonKey, authorization: 'Bearer ' + auth.accessToken, 'content-type': 'application/json' }
  }
  const raw = async (route: string, init: RequestInit) => {
    try {
      const response = await request(endpoint(route), { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30000) })
      if (response.redirected || response.url !== endpoint(route)) throw Error()
      return response
    }
    catch { throw new ClosureV2HttpFailure('outcome_unknown', true) }
  }
  return {
    async policy(auth: ClosureV2Auth): Promise<AccountClosureV2Policy> {
      let response: Response
      try { response = await raw('status', { method: 'GET', headers: authHeaders(auth) }) }
      catch { throw new ClosureV2HttpFailure('closure_unavailable') }
      let body: unknown
      try { body = await jsonBody(response) } catch { throw new ClosureV2HttpFailure('closure_unavailable') }
      if (!response.ok) throw new ClosureV2HttpFailure(response.status === 401 ? 'unauthorized' : 'closure_unavailable')
      const p = object(body) ? body.policy : null
      if (!object(p) || p.protocol_version !== 2 || typeof p.available !== 'boolean' || p.deletion !== 'immediate'
          || p.credit_treatment !== 'forfeit_remaining' || p.consent_version !== 'immediate-forfeit-v1' || p.device_preparation_required !== true) throw new ClosureV2HttpFailure('closure_unavailable')
      return { protocol_version: 2, available: p.available, deletion: 'immediate', credit_treatment: 'forfeit_remaining', consent_version: 'immediate-forfeit-v1', device_preparation_required: true }
    },
    async post(route: ClosureV2Route, binding: ClosureV2Binding, extra: Record<string, string | number | boolean | null> = {}, auth?: ClosureV2Auth): Promise<ClosureV2Reply> {
      if (!Object.hasOwn(fields, route) || Object.keys(extra).some(key => !fields[route].includes(key))) throw new ClosureV2HttpFailure('invalid_scope')
      if (!binding.localOperationId || Buffer.byteLength(binding.localOperationId) > 256 || !/^[a-f0-9]{64}$/.test(binding.receipt)) throw new ClosureV2HttpFailure('invalid_scope')
      if ((route !== 'result' && !auth) || (auth && (auth.ownerId !== binding.ownerId || (route !== 'result' && auth.sessionId !== binding.sessionId)))) throw new ClosureV2HttpFailure('wrong_local_owner')
      const headers = route === 'result' ? { apikey: input.anonKey, 'content-type': 'application/json' } : authHeaders(auth!)
      const body = JSON.stringify({ ...extra, local_operation_id: binding.localOperationId, receipt_token: binding.receipt })
      if (Buffer.byteLength(body) > 4096) throw new ClosureV2HttpFailure('invalid_scope')
      const response = await raw(route, { method: 'POST', headers, body })
      const doc = await jsonBody(response)
      if (!response.ok) {
        if (route === 'confirm' && response.status === 422 && object(doc) && doc.error === 'verification_failed') {
          let rejection: ClosureV2Reply | null = null
          try { const parsed = parseClosureV2Reply(doc); if (isMatchingClosureRejection(parsed, binding)) rejection = parsed }
          catch { /* Missing proof remains an unknown confirmation below. */ }
          if (rejection) throw new ClosureV2HttpFailure('verification_failed', false, rejection)
          throw new ClosureV2HttpFailure('outcome_unknown', true)
        }
        const code = object(doc) && isAccountClosureV2ErrorCode(doc.error) ? doc.error : 'closure_unavailable'
        throw new ClosureV2HttpFailure(code, true)
      }
      return parseClosureV2Reply(doc)
    },
  }
}
