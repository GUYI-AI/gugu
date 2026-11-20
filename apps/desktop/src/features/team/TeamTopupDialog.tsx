import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { refreshFailure, useReplica } from '@/lib/replica'
import { teamApiKey, teamTopupOrder, teamTopupQuote } from './replicas'
import { useTranslation } from 'react-i18next'
import { serverNow } from '@gugu/core/shared/serverClock'
import { useAuth } from '@/store/auth'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { TeamCheckoutError, teamCnyCents, teamTopupAmount, type TeamCheckoutIntent, type TeamPayType } from '../../../shared/team-topup'
import { useTeamApi, useTeamSession } from './context'
import { teamErrorCopy } from './copy'
import { TeamDialog } from './TeamPrimitives'
import { createTeamTopupCheckout, openTeamPayment, type OpenTeamPayment } from './topup-checkout'

function moveRadio<T extends number | string>(event: KeyboardEvent<HTMLDivElement>, values: readonly T[], current: T | null, choose: (value: T) => void) {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
  if (!step) return
  event.preventDefault()
  const index = (Math.max(0, values.findIndex(value => value === current)) + step + values.length) % values.length
  choose(values[index]); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')[index]?.focus()
}

export function TeamTopupDialog({ onClose, onSettled, openPayment = openTeamPayment }: {
  onClose(): void; onSettled(): Promise<void>; openPayment?: OpenTeamPayment
}) {
  const { t, i18n } = useTranslation('team'), { user } = useAuth(), api = useTeamApi(), session = useTeamSession()
  const teamId = session.context?.team_id ?? '', actorId = user?.id ?? ''
  const checkout = useMemo(() => createTeamTopupCheckout(actorId, teamId, localStorage, openPayment), [actorId, teamId, openPayment])
  const [amountText, setAmountText] = useState('500'), [couponText, setCouponText] = useState(''), [couponCode, setCouponCode] = useState('')
  const [method, setMethod] = useState<TeamPayType>('alipay'), [intent, setIntent] = useState<TeamCheckoutIntent | null>(null)
  const [initialized, setInitialized] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [, tick] = useState(0), alive = useRef(true), settled = useRef<string | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    try { setIntent(checkout.read()); setInitialized(true) } catch (cause) { setError(teamErrorCopy(cause, t)) }
  }, [checkout, t])
  const amount = teamTopupAmount(amountText), admin = session.status === 'ready' && session.context?.role !== 'member'
  const context = session.context
  const quote = useReplica(teamTopupQuote, admin && initialized && !intent && amount !== null && context
    ? [teamApiKey(api), teamId, context.membership_revision, amount, couponCode] : null)
  const quoteFailure = refreshFailure(quote)
  const offered = quote.state === 'value' ? quote.value : undefined, expired = offered ? offered.expiresAt <= serverNow() : false
  const current = offered && offered.teamId === teamId && offered.credits === amount && !expired && !quoteFailure
    && offered.couponCode === (couponCode || null) && couponText.trim().toUpperCase() === couponCode ? offered : null
  useEffect(() => {
    if (!offered || expired) return
    const timer = setTimeout(() => tick(value => value + 1), Math.max(0, offered.expiresAt - serverNow() + 1))
    return () => clearTimeout(timer)
  }, [offered, expired])
  const order = useReplica(teamTopupOrder, admin && intent?.orderId
    ? [teamApiKey(api), teamId, intent.orderId, intent.quote.amountCny, intent.quote.credits] : null)
  const settledOrder = order.state === 'value' ? order.value : undefined
  const orderFailure = refreshFailure(order)
  // @@@effect-flow(command) - settling this checkout consumes its original intent and refreshes the parent balance.
  // Order data stays in the query; the asynchronous continuation only reports this interaction's refresh failure.
  useEffect(() => {
    const value = settledOrder
    if (!value || value.status === 'pending' || settled.current === value.id) return
    settled.current = value.id
    try {
      checkout.clear(); setIntent(null); setNotice(t(value.status === 'paid' ? 'paymentPaid' : 'paymentFinished'))
      void onSettled().catch(cause => { if (alive.current) setError(teamErrorCopy(cause, t)) })
    } catch (cause) { setError(teamErrorCopy(cause, t)) }
  }, [settledOrder, checkout, onSettled, t])
  const money = (value: string) => new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'CNY', maximumFractionDigits: 2,
    minimumFractionDigits: 0 }).format(teamCnyCents(value) / 100)
  async function pay() {
    if (!admin || !initialized || busy || (!intent && !current)) return
    setBusy(true); setError(''); setNotice('')
    try {
      const accepted = intent ? await checkout.retry() : await checkout.start(current!, method)
      if (alive.current) setIntent(accepted)
    } catch (cause) {
      if (alive.current) {
        setError(teamErrorCopy(cause, t))
        try { setIntent(checkout.read()) } catch (readError) { setError(teamErrorCopy(readError, t)); setInitialized(false) }
      }
    } finally { if (alive.current) setBusy(false) }
  }
  if (!admin) return null
  const displayed = intent?.quote ?? current
  return <TeamDialog title={t('recharge')} onClose={() => { if (!busy) onClose() }} actions={<>
    <Button onClick={onClose} disabled={busy}>{t('close')}</Button>
    <Button variant="primary" disabled={busy || !initialized || (!intent && !current)} onClick={() => { void pay() }}>
      {busy ? t('creatingPayment') : intent ? t('continuePayment') : displayed ? t('payAmount', { amount: money(displayed.amountCny) }) : t('pay')}
    </Button>
  </>}>
    {notice && <p role="status">{notice}</p>}
    {!intent && <>
      <div className="gg-team-topup-presets" role="radiogroup" aria-label={t('topupPresets')}
        onKeyDown={event => moveRadio(event, [100, 500, 1000], amount, value => setAmountText(String(value)))}>
        {[100, 500, 1000].map(value => <Button key={value} variant="option" disabled={busy} role="radio" tabIndex={amount === value || (![100, 500, 1000].includes(amount ?? 0) && value === 100) ? 0 : -1}
          aria-checked={amount === value} onClick={() => setAmountText(String(value))}>
          <span>{t('topupCredits', { count: value })}</span>{value >= 500 && <small className="gg-team-topup-rate">{t(value >= 1000 ? 'rate90' : 'rate95')}</small>}
        </Button>)}
      </div>
      <Field.Root disabled={busy}><Field.Label>{t('topupAmount')}</Field.Label>
        <Field.Input value={amountText} inputMode="numeric" onChange={event => setAmountText(event.target.value)} />
        <Field.Description>{t('topupHint')}</Field.Description></Field.Root>
      <Field.Root disabled={busy}><Field.Label>{t('coupon')}</Field.Label><div className="gg-team-topup-coupon">
        <Field.Input value={couponText} maxLength={64} autoComplete="off" onChange={event => setCouponText(event.target.value)} />
        <Button disabled={busy || !couponText.trim()} onClick={() => { setCouponCode(couponText.trim().toUpperCase()); setError('') }}>{t('applyCoupon')}</Button>
        {(couponText || couponCode) && <Button variant="ghost" disabled={busy} onClick={() => { setCouponText(''); setCouponCode(''); setError('') }}>{t('removeCoupon')}</Button>}
      </div></Field.Root>
      <div role="radiogroup" aria-label={t('paymentMethod')} className="gg-team-topup-methods"
        onKeyDown={event => moveRadio(event, ['alipay', 'wxpay'] as const, method, setMethod)}>
        {(['alipay', 'wxpay'] as const).map(value => <Button key={value} role="radio" aria-checked={method === value} tabIndex={method === value ? 0 : -1} disabled={busy}
          variant="option" onClick={() => setMethod(value)}>{t(value === 'alipay' ? 'alipay' : 'wxpay')}</Button>)}
      </div>
    </>}
    {!intent && initialized && amount !== null && quote.state === 'unknown' && <p role="status">{t('quoteLoading')}</p>}
    {displayed && <div className="gg-team-topup-total" aria-live="polite">
      <strong>{money(displayed.amountCny)}</strong>
      <span>{t('topupCredits', { count: displayed.credits })}</span>
      {displayed.couponCode && <small>{t('couponAccepted', { code: displayed.couponCode, amount: money(displayed.couponDiscountCny) })}</small>}
      {displayed.credits * 100 > teamCnyCents(displayed.amountCny) && <small>{t('topupSaved', { amount: money(((displayed.credits * 100 - teamCnyCents(displayed.amountCny)) / 100).toFixed(2)) })}</small>}
    </div>}
    {!intent && (amount === null || expired || quoteFailure) && <p role="alert" className="gg-team-error">
      {amount === null ? t('topupInvalid') : expired ? t('quoteExpired') : teamErrorCopy(quoteFailure, t)}
      {amount !== null && quote.state !== 'unknown' && <Button variant="ghost" onClick={() => { void quote.retry?.() }}>{t('retry')}</Button>}
    </p>}
    {intent && <p role="status" className="gg-team-muted">{t('paymentPending')}</p>}
    {orderFailure && order.state !== 'unknown' && <p role="alert" className="gg-team-error">{teamErrorCopy(orderFailure, t)}<Button onClick={() => { void order.retry?.() }}>{t('retry')}</Button></p>}
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}
