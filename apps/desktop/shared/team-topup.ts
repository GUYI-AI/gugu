export type TeamPayType = 'alipay' | 'wxpay'
export interface TeamTopupQuote {
  id: string; teamId: string; credits: number; discountRate: '1.00' | '0.95' | '0.90'
  amountCny: string; couponCode: string | null; couponDiscountCny: string; expiresAt: number
}
export interface TeamCheckoutIntent {
  version: 1; actorId: string; teamId: string; quote: TeamTopupQuote
  payType: TeamPayType; key: string; orderId?: string
}
export interface TeamTopupOrder {
  id: string; teamId: string; credits: number; amountCny: string
  status: 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded'
}
export class TeamCheckoutError extends Error {
  constructor(readonly code: string) { super('Team checkout failed'); this.name = 'TeamCheckoutError' }
}
const invalid = (): never => { throw new TeamCheckoutError('invalid_response') }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : invalid()
const text = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 254 ? value : invalid()
export function teamCnyCents(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{2}$/.test(value)) return invalid()
  const [whole, fraction] = value.split('.')
  return Number(whole) * 100 + Number(fraction)
}
export function teamTopupAmount(value: string): number | null {
  if (!/^\d{1,6}$/.test(value)) return null
  const amount = Number(value)
  return amount >= 100 && amount <= 100000 ? amount : null
}
function credits(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+(?:\.0{1,8})?$/.test(value)) return invalid()
  return teamTopupAmount(value.split('.')[0]) ?? invalid()
}
export function readTeamTopupQuote(value: unknown, expected: { teamId: string; credits: number; couponCode?: string | null }): TeamTopupQuote {
  const row = object(value), n = credits(row.credits)
  if (row.unit_version !== 2 || n !== expected.credits || teamCnyCents(row.face_value_cny) !== n * 100
    || typeof row.discount_rate !== 'string' || !['1.00', '0.95', '0.90'].includes(row.discount_rate)) return invalid()
  const rate = row.discount_rate as TeamTopupQuote['discountRate'], amount = teamCnyCents(row.amount_cny)
  const code = row.coupon_code === null ? null : text(row.coupon_code), deduction = teamCnyCents(row.coupon_discount_cny)
  const requestedCode = expected.couponCode?.trim().toUpperCase() || null
  if (code !== requestedCode || (code === null ? deduction !== 0 : !/^[A-Z0-9_-]{3,64}$/.test(code) || deduction <= 0)
    || amount <= 0 || amount !== n * (rate === '0.95' ? 95 : rate === '0.90' ? 90 : 100) - deduction) return invalid()
  const expiresAt = Date.parse(text(row.expires_at))
  if (!Number.isFinite(expiresAt)) return invalid()
  return { id: text(row.quote_id), teamId: expected.teamId, credits: n, discountRate: rate,
    amountCny: row.amount_cny as string, couponCode: code, couponDiscountCny: row.coupon_discount_cny as string, expiresAt }
}
export function readTeamTopupOrder(value: unknown, expected: { teamId: string; id?: string }): TeamTopupOrder {
  const row = object(value), n = credits(row.credited_credits)
  if ((row.team_id !== undefined && row.team_id !== expected.teamId)
    || (row.out_trade_no !== undefined && expected.id !== undefined && row.out_trade_no !== expected.id) || !['pending', 'paid', 'failed', 'refunded', 'partially_refunded'].includes(String(row.status))
    || teamCnyCents(row.amount_cny) <= 0) return invalid()
  return { id: text(row.out_trade_no ?? expected.id), teamId: expected.teamId, credits: n, amountCny: row.amount_cny as string, status: row.status as TeamTopupOrder['status'] }
}
export function readTeamCheckoutIntent(value: unknown, actorId: string, teamId: string): TeamCheckoutIntent {
  const row = object(value), q = object(row.quote)
  if (row.version !== 1 || row.actorId !== actorId || row.teamId !== teamId || q.teamId !== teamId
    || (row.payType !== 'alipay' && row.payType !== 'wxpay') || typeof q.expiresAt !== 'number' || !Number.isFinite(q.expiresAt) || Math.abs(q.expiresAt) > 8.64e15
    || typeof q.credits !== 'number' || teamTopupAmount(String(q.credits)) !== q.credits
    || typeof row.key !== 'string' || !row.key || row.key.length > 128) return invalid()
  const quote = readTeamTopupQuote({ quote_id: q.id, unit_version: 2, credits: String(q.credits),
    face_value_cny: q.credits.toFixed(2), discount_rate: q.discountRate, amount_cny: q.amountCny,
    coupon_code: q.couponCode, coupon_discount_cny: q.couponDiscountCny, expires_at: new Date(q.expiresAt).toISOString(),
  }, { teamId, credits: q.credits, couponCode: q.couponCode === null ? null : text(q.couponCode) })
  return { version: 1, actorId, teamId, quote, payType: row.payType, key: row.key,
    ...(row.orderId === undefined ? {} : { orderId: text(row.orderId) }) }
}
