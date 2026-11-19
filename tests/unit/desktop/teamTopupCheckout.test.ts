import { expect, it, vi } from 'vitest'
import { createTeamTopupCheckout } from '../../../apps/desktop/src/features/team/topup-checkout'
import { readTeamTopupQuote, TeamCheckoutError, type TeamTopupQuote, type TeamCheckoutIntent } from '../../../apps/desktop/shared/team-topup'
const memory = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const quote = (): TeamTopupQuote => ({ id: 'quote-a', teamId: 'team-a', credits: 500, discountRate: '0.95', amountCny: '425.00',
  couponCode: 'NEWTEAM', couponDiscountCny: '50.00', expiresAt: Date.now() + 600000 })
it('reads exact credit, coupon and final-cash terms and rejects a silently omitted or changed coupon', () => {
  const wire = { quote_id: 'quote-a', unit_version: 2, credits: '500.00000000', face_value_cny: '500.00', discount_rate: '0.95',
    amount_cny: '425.00', coupon_code: 'NEWTEAM', coupon_discount_cny: '50.00', expires_at: new Date(Date.now() + 600000).toISOString() }
  const expected = { teamId: 'team-a', credits: 500, couponCode: 'NEWTEAM' }
  expect(readTeamTopupQuote(wire, expected)).toMatchObject({ id: 'quote-a', teamId: 'team-a', credits: 500, amountCny: '425.00', couponCode: 'NEWTEAM', couponDiscountCny: '50.00' })
  for (const changed of [{ amount_cny: '475.00' }, { coupon_code: null }, { coupon_discount_cny: '-50.00' },
    { credited_credits: '499', credits: '499' }, { discount_rate: 0.95 }, { unit_version: 1 }])
    expect(() => readTeamTopupQuote({ ...wire, ...changed }, expected)).toThrow(TeamCheckoutError)
})
it('persists the original coupon intent before opening and recovers the same key after a lost response and expiry', async () => {
  const storage = memory(), seen: unknown[] = []
  const open = vi.fn(async (intent: TeamCheckoutIntent) => { seen.push(intent); throw new TeamCheckoutError('dependency_unavailable') })
  const first = createTeamTopupCheckout('actor-a', 'team-a', storage, open)
  await expect(first.start(quote(), 'alipay')).rejects.toMatchObject({ code: 'dependency_unavailable' })
  const original = first.read()!
  expect(original.quote.couponCode).toBe('NEWTEAM')
  original.quote.expiresAt = Date.now() - 1
  storage.setItem('gugu:team-topup:v1:actor-a:team-a', JSON.stringify(original))
  const reload = createTeamTopupCheckout('actor-a', 'team-a', storage, open)
  await expect(reload.retry()).rejects.toMatchObject({ code: 'dependency_unavailable' })
  expect(open.mock.calls[1][0]).toEqual(original)
  expect(open.mock.calls[0][0].key).toBe(original.key)
  expect(createTeamTopupCheckout('actor-b', 'team-a', storage, open).read()).toBeNull()
  expect(() => reload.start({ ...quote(), id: 'new-quote' }, 'wxpay')).toThrow(expect.objectContaining({ code: 'checkout_pending' }))
})
it('stops before opening when recovery storage cannot be written and clears only a definite first-order refusal', async () => {
  const open = vi.fn(async () => ({ ok: false as const, error: { code: 'coupon_unavailable' } }))
  const broken = { getItem: () => null, setItem: () => { throw Error('owned storage failure') }, removeItem: () => {} }
  expect(() => createTeamTopupCheckout('actor-a', 'team-a', broken, open).start(quote(), 'alipay')).toThrow(expect.objectContaining({ code: 'storage_unavailable' }))
  expect(open).not.toHaveBeenCalled()
  const service = createTeamTopupCheckout('actor-a', 'team-a', memory(), open)
  await expect(service.start(quote(), 'alipay')).rejects.toMatchObject({ code: 'coupon_unavailable' })
  expect(service.read()).toBeNull()
})
