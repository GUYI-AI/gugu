import { readTeamCheckoutIntent, TeamCheckoutError, type TeamCheckoutIntent, type TeamPayType, type TeamTopupQuote, type TeamTopupOrder } from '../../../shared/team-topup'

export type OpenTeamPayment = (intent: TeamCheckoutIntent) => Promise<{ ok: true; order: TeamTopupOrder } | { ok: false; error: { code: string } }>
const definitive = new Set(['invalid_amount', 'invalid_request', 'quote_expired', 'coupon_invalid', 'coupon_unavailable', 'coupon_not_applicable'])
export function createTeamTopupCheckout(actorId: string, teamId: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, open: OpenTeamPayment) {
  const key = `gugu:team-topup:v1:${actorId}:${teamId}`
  let flight: Promise<TeamCheckoutIntent> | null = null
  const read = (): TeamCheckoutIntent | null => {
    let raw: string | null
    try { raw = storage.getItem(key) } catch { throw new TeamCheckoutError('storage_unavailable') }
    if (raw === null) return null
    try { return readTeamCheckoutIntent(JSON.parse(raw), actorId, teamId) }
    catch { throw new TeamCheckoutError('recovery_invalid') }
  }
  const write = (intent: TeamCheckoutIntent) => {
    const raw = JSON.stringify(intent)
    try { storage.setItem(key, raw); if (storage.getItem(key) !== raw) throw new Error('Team checkout storage readback differs') }
    catch { throw new TeamCheckoutError('storage_unavailable') }
  }
  const clear = () => { try { storage.removeItem(key) } catch { throw new TeamCheckoutError('storage_unavailable') } }
  async function perform(intent: TeamCheckoutIntent): Promise<TeamCheckoutIntent> {
    if (flight) return flight
    flight = open(intent).then(answer => {
      if (!answer.ok) throw new TeamCheckoutError(answer.error.code)
      const order = answer.order
      if (order.teamId !== teamId || order.credits !== intent.quote.credits || order.amountCny !== intent.quote.amountCny || !order.id.startsWith('gtt-'))
        throw new TeamCheckoutError('invalid_response')
      const accepted = { ...intent, orderId: order.id }; write(accepted); return accepted
    }).catch(cause => {
      if (!intent.orderId && cause instanceof TeamCheckoutError && definitive.has(cause.code)) clear()
      throw cause
    }).finally(() => { flight = null })
    return flight
  }
  return {
    read, clear,
    start(quote: TeamTopupQuote, payType: TeamPayType) {
      const existing = read()
      if (existing) {
        if (existing.quote.id !== quote.id || existing.payType !== payType) throw new TeamCheckoutError('checkout_pending')
        return perform(existing)
      }
      if (quote.teamId !== teamId || quote.expiresAt <= Date.now()) throw new TeamCheckoutError('quote_expired')
      const intent = readTeamCheckoutIntent({ version: 1, actorId, teamId, quote, payType, key: crypto.randomUUID() }, actorId, teamId)
      write(intent)
      return perform(intent)
    },
    retry() { const intent = read(); if (!intent) throw new TeamCheckoutError('not_found'); return perform(intent) },
  }
}
export const openTeamPayment: OpenTeamPayment = async intent => {
  const invoke = window.electronAPI?.invoke
  if (!invoke) throw new TeamCheckoutError('payment_unavailable')
  const answer = await invoke('team-payment:open', intent)
  if (!answer || typeof answer !== 'object' || !('ok' in answer)) throw new TeamCheckoutError('invalid_response')
  const value = answer as Awaited<ReturnType<OpenTeamPayment>>
  if (value.ok !== true && value.ok !== false) throw new TeamCheckoutError('invalid_response')
  if (value.ok === false && (!value.error || typeof value.error.code !== 'string')) throw new TeamCheckoutError('invalid_response')
  if (value.ok === true && (!value.order || typeof value.order.id !== 'string')) throw new TeamCheckoutError('invalid_response')
  return value
}
