import { TeamCheckoutError, readTeamCheckoutIntent, readTeamTopupOrder, teamCnyCents, type TeamTopupOrder } from '../shared/team-topup'

type Auth = { userId: string; accessToken: string }
type OpenedPayment = { ready: Promise<void>; close(): void }
interface Dependencies {
  auth(): Promise<Auth | null>
  url(): string
  anonKey(): string
  fetch: typeof globalThis.fetch
  open(input: { url: string; parameters: Record<string, string>; closed(): void }): OpenedPayment
  report(error: unknown): void
}
export type TeamPaymentAnswer = { ok: true; order: TeamTopupOrder } | { ok: false; error: { code: string } }
const safeCodes = new Set(['unauthenticated', 'team_identity_required', 'forbidden', 'membership_disabled', 'region_mismatch',
  'invalid_request', 'invalid_amount', 'quote_expired', 'idempotency_conflict', 'coupon_invalid', 'coupon_unavailable',
  'coupon_not_applicable', 'rate_limited', 'not_found', 'billing_unavailable', 'dependency_unavailable', 'invalid_response', 'context_changed', 'payment_open_failed'])
function sessionIdentity(auth: Auth | null): string | null {
  if (!auth?.userId || !auth.accessToken) return null
  try {
    const body = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString()) as { session_id?: unknown }
    return typeof body.session_id === 'string' && body.session_id ? `${auth.userId}:${body.session_id}` : null
  } catch { return null }
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeamCheckoutError('invalid_response')
  return value as Record<string, unknown>
}

/** The renderer supplies only an approved intent. URLs and form signatures come from the verified server response. */
export function createTeamPaymentCheckout(deps: Dependencies) {
  let identity: string | null = null, generation = 0
  const windows = new Map<string, OpenedPayment>()
  const pending = new Map<string, { fingerprint: string; result: Promise<TeamPaymentAnswer> }>()
  function identityChanged(auth: Auth | null) {
    const next = sessionIdentity(auth)
    if (identity === next) return
    identity = next; generation++
    for (const window of windows.values()) window.close()
    windows.clear()
  }
  async function run(value: unknown): Promise<TeamPaymentAnswer> {
    try {
      const auth = await deps.auth(), raw = record(value)
      if (!auth || !sessionIdentity(auth)) throw new TeamCheckoutError('unauthenticated')
      if (raw.actorId !== auth.userId || typeof raw.teamId !== 'string') throw new TeamCheckoutError('team_identity_required')
      const intent = readTeamCheckoutIntent(raw, auth.userId, raw.teamId)
      identityChanged(auth)
      const started = generation, key = `${intent.actorId}:${intent.teamId}:${intent.key}`
      const response = await deps.fetch(`${deps.url().replace(/\/$/, '')}/functions/v1/pay-create`, {
        method: 'POST', headers: { apikey: deps.anonKey(), Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json',
          'x-gugu-credit-unit-version': '2' },
        body: JSON.stringify({ order_kind: 'team_topup', team_id: intent.teamId, quote_id: intent.quote.id,
          pay_type: intent.payType, idempotency_key: intent.key }), signal: AbortSignal.timeout(30000),
      })
      const answer = record(await response.json())
      if (!response.ok || answer.ok !== true) {
        const failure = record(answer.error), code = failure.code
        throw new TeamCheckoutError(typeof code === 'string' && safeCodes.has(code) ? code : 'dependency_unavailable')
      }
      const data = record(answer.data), quote = intent.quote
      if (data.order_kind !== 'team_topup' || data.team_id !== intent.teamId || data.credit_unit_version !== 2
        || data.pay_type !== intent.payType || data.amount_cny !== quote.amountCny || data.discount_rate !== quote.discountRate
        || data.coupon_code !== quote.couponCode || data.coupon_discount_cny !== quote.couponDiscountCny
        || teamCnyCents(data.face_value_cny) !== quote.credits * 100) throw new TeamCheckoutError('invalid_response')
      const order = readTeamTopupOrder(data, { teamId: intent.teamId })
      if (order.credits !== quote.credits || !order.id.startsWith('gtt-')) throw new TeamCheckoutError('invalid_response')
      const current = await deps.auth()
      if (started !== generation || sessionIdentity(current) !== sessionIdentity(auth)) throw new TeamCheckoutError('context_changed')
      if (order.status !== 'pending') {
        windows.get(key)?.close(); windows.delete(key)
        return { ok: true, order }
      }
      if (!windows.has(key)) {
        if (typeof data.pay_url !== 'string' || data.pay_url.length > 2048) throw new TeamCheckoutError('invalid_response')
        const target = new URL(data.pay_url), parameters = record(data.pay_params)
        if (target.protocol !== 'https:' || target.username || target.password
          || Object.values(parameters).some(item => typeof item !== 'string')
          || parameters.money !== order.amountCny || parameters.out_trade_no !== order.id
          || parameters.type !== intent.payType) throw new TeamCheckoutError('invalid_response')
        const payment = deps.open({ url: target.href, parameters: parameters as Record<string, string>, closed: () => windows.delete(key) })
        windows.set(key, payment)
        try { await payment.ready } catch (cause) {
          payment.close(); windows.delete(key)
          deps.report(cause)
          throw new TeamCheckoutError(started === generation ? 'payment_open_failed' : 'context_changed')
        }
        if (started !== generation) throw new TeamCheckoutError('context_changed')
      }
      return { ok: true, order }
    } catch (cause) {
      if (!(cause instanceof TeamCheckoutError)) deps.report(cause)
      return { ok: false, error: { code: cause instanceof TeamCheckoutError && safeCodes.has(cause.code) ? cause.code : 'dependency_unavailable' } }
    }
  }
  return {
    identityChanged,
    close() { for (const window of windows.values()) window.close(); windows.clear() },
    request(value: unknown): Promise<TeamPaymentAnswer> {
      let key: string, fingerprint: string
      try {
        const raw = record(value)
        if (typeof raw.actorId !== 'string' || typeof raw.teamId !== 'string' || typeof raw.key !== 'string') throw new TeamCheckoutError('invalid_request')
        key = `${raw.actorId}:${raw.teamId}:${raw.key}`; fingerprint = JSON.stringify(value)
      } catch { return Promise.resolve({ ok: false, error: { code: 'invalid_request' } }) }
      const existing = pending.get(key)
      if (existing) return existing.fingerprint === fingerprint ? existing.result
        : Promise.resolve({ ok: false, error: { code: 'idempotency_conflict' } })
      const result = run(value).finally(() => { if (pending.get(key)?.result === result) pending.delete(key) })
      pending.set(key, { fingerprint, result })
      return result
    },
  }
}
