import { expect, it, vi } from 'vitest'
import { createTeamPaymentCheckout } from '../../../../apps/desktop/electron/team-payment-checkout'
import type { TeamCheckoutIntent } from '../../../../apps/desktop/shared/team-topup'
const actor = '11111111-1111-4111-8111-111111111111', team = '22222222-2222-4222-8222-222222222222'
const token = (session = 'session-a', expiry = 1) => `header.${Buffer.from(JSON.stringify({ session_id: session, exp: expiry })).toString('base64url')}.fixture-signature`
function fixture() {
  let auth: { userId: string; accessToken: string } | null = { userId: actor, accessToken: token() }
  const intent: TeamCheckoutIntent = { version: 1, actorId: actor, teamId: team, payType: 'alipay', key: 'immutable-intent',
    quote: { id: '33333333-3333-4333-8333-333333333333', teamId: team, credits: 500, discountRate: '0.95',
      amountCny: '425.00', couponCode: 'NEWTEAM', couponDiscountCny: '50.00', expiresAt: Date.now() + 600000 } }
  const data = { order_kind: 'team_topup', team_id: team, credit_unit_version: 2, pay_type: 'alipay',
    out_trade_no: 'gtt-owned-fixture', status: 'pending', credited_credits: '500.00000000', face_value_cny: '500.00',
    discount_rate: '0.95', amount_cny: '425.00', coupon_code: 'NEWTEAM', coupon_discount_cny: '50.00',
    pay_url: 'https://payment.example.invalid/submit', pay_params: { pid: 'fixture-merchant', type: 'alipay', money: '425.00',
      out_trade_no: 'gtt-owned-fixture', name: '咕咕 团队+会员', sign: 'fixture-only-signature' } }
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, data })))
  type Page = Parameters<Parameters<typeof createTeamPaymentCheckout>[0]['open']>[0]
  const close = vi.fn(), open = vi.fn((_page: Page) => ({ ready: Promise.resolve(), close })), report = vi.fn()
  const host = createTeamPaymentCheckout({ auth: async () => auth, url: () => 'https://owned-backend.invalid',
    anonKey: () => 'public-fixture-key', fetch: fetcher, open, report })
  return { intent, data, fetcher, open, close, report, host, setAuth(next: typeof auth) { auth = next; host.identityChanged(auth) } }
}
it('uses current main Auth and server-owned form data, coalesces duplicate intent calls and returns no signatures', async () => {
  const f = fixture()
  const first = f.host.request({ ...f.intent, pay_url: 'https://attacker.invalid', pay_params: { money: '1' } })
  const again = f.host.request({ ...f.intent, pay_url: 'https://attacker.invalid', pay_params: { money: '1' } })
  expect(first).toBe(again)
  const answer = await first
  expect(answer).toMatchObject({ ok: true, order: { id: 'gtt-owned-fixture', credits: 500, amountCny: '425.00' } })
  expect(JSON.stringify(answer)).not.toMatch(/pay_params|sign|accessToken/)
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  const [url, options] = f.fetcher.mock.calls[0]
  expect(url).toBe('https://owned-backend.invalid/functions/v1/pay-create')
  expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${token()}`)
  expect(JSON.parse(String(options?.body))).toEqual({ order_kind: 'team_topup', team_id: team, quote_id: f.intent.quote.id,
    pay_type: 'alipay', idempotency_key: 'immutable-intent' })
  expect(f.open.mock.calls[0][0]).toMatchObject({ url: f.data.pay_url, parameters: f.data.pay_params })
})
it('refuses another principal before HTTP and rejects a different body using an in-flight key', async () => {
  const f = fixture()
  expect(await f.host.request({ ...f.intent, actorId: 'another-principal' })).toMatchObject({ ok: false, error: { code: 'team_identity_required' } })
  expect(f.fetcher).not.toHaveBeenCalled()
  let release!: (response: Response) => void
  f.fetcher.mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
  const original = f.host.request(f.intent)
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1))
  expect(await f.host.request({ ...f.intent, payType: 'wxpay' })).toMatchObject({ ok: false, error: { code: 'idempotency_conflict' } })
  release(new Response(JSON.stringify({ ok: true, data: f.data })))
  expect(await original).toMatchObject({ ok: true })
})
it.each(['amount_cny', 'coupon_code', 'coupon_discount_cny', 'team_id'])('refuses a mismatched %s without opening a browser', async field => {
  const f = fixture()
  f.fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { ...f.data, [field]: 'mismatch' } })))
  expect(await f.host.request(f.intent)).toMatchObject({ ok: false, error: { code: 'invalid_response' } })
  expect(f.open).not.toHaveBeenCalled()
})
it('does not open an old account payment after an Auth boundary changes during HTTP', async () => {
  const f = fixture(); let release!: (response: Response) => void
  f.fetcher.mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
  const pending = f.host.request(f.intent)
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1))
  f.setAuth({ userId: 'another-principal', accessToken: token('session-b') })
  release(new Response(JSON.stringify({ ok: true, data: f.data })))
  expect(await pending).toMatchObject({ ok: false, error: { code: 'context_changed' } })
  expect(f.open).not.toHaveBeenCalled()
})
it('preserves a payment across token renewal but closes it on logout or a replacement Auth session', async () => {
  const f = fixture()
  await f.host.request(f.intent)
  f.setAuth({ userId: actor, accessToken: token('session-a', 2) })
  expect(f.close).not.toHaveBeenCalled()
  f.setAuth({ userId: actor, accessToken: token('session-b') })
  expect(f.close).toHaveBeenCalledTimes(1)
})
it('replays an expired original quote and never reopens a server-paid order', async () => {
  const f = fixture(); f.intent.quote.expiresAt = Date.now() - 1000; f.data.status = 'paid'
  expect(await f.host.request(f.intent)).toMatchObject({ ok: true, order: { status: 'paid' } })
  expect(f.open).not.toHaveBeenCalled()
})
it('keeps a safe coupon refusal separate from private server diagnostics', async () => {
  const f = fixture()
  f.fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'coupon_unavailable', message: 'private campaign details' } }), { status: 409 }))
  const answer = await f.host.request(f.intent)
  expect(answer).toEqual({ ok: false, error: { code: 'coupon_unavailable' } })
  expect(f.open).not.toHaveBeenCalled(); expect(JSON.stringify(answer)).not.toContain('private')
})
