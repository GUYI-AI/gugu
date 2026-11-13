import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeReferralCode, parseReferralLink } from '@gugu/core/shared/referralLink'
import { claimMyReferral } from '@/lib/referrals'
import { clearPersonalReferral, pendingPersonalReferral, refreshPersonalReferrals } from '@/lib/referralPending'
import { Button } from '../ui/Button'
import { useReferral } from './useReferral'

export function ReferralClaimField({ userId }: { userId: string }) {
  const fieldId = useId()
  const { t } = useTranslation('main')
  const { data, failed, reload } = useReferral(userId)
  const [draft, setDraft] = useState(() => {
    try { return pendingPersonalReferral(userId) || localStorage.getItem(`gugu:referral-code:${userId}`) || '' }
    catch { return '' }
  })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const change = (value: string) => {
    setDraft(value)
    setStatus(null)
    try { localStorage.setItem(`gugu:referral-code:${userId}`, value) }
    catch { setStatus('storage_error') }
  }
  const submit = async () => {
    const code = parseReferralLink(draft) ?? normalizeReferralCode(draft)
    if (!code) { setStatus('invalid_code'); return }
    setBusy(true)
    try {
      const result = await claimMyReferral(userId, code)
      setStatus(result)
      if (result === 'attributed' || result === 'already_attributed') {
        try { clearPersonalReferral(userId); localStorage.removeItem(`gugu:referral-code:${userId}`) }
        catch { /* The confirmed server source remains authoritative. */ }
        refreshPersonalReferrals(userId)
      }
    } catch { setStatus('unavailable') }
    finally { setBusy(false) }
  }
  if (data?.attribution) return <p role="status" className="m-0 text-[var(--muted-fg)]">{t('referrals.confirmedSource', { code: data.attribution.code })}</p>
  if (data && !data.claim_available) return <p className="m-0 text-[var(--muted-fg)]">{t('referrals.claimUnavailable')}</p>
  return (
    <div className="ta-onb-field" data-testid="referral-preview-onboarding">
      <label htmlFor={fieldId} className="ta-field-label">{t('referralPreview.optionalCode')}</label>
      <div className="flex items-center gap-2">
        <input id={fieldId} className="ta-input min-w-0 flex-1" autoComplete="off"
          value={draft} onChange={event => change(event.target.value)} disabled={busy}
          placeholder={t('referralPreview.placeholder')} aria-describedby={`${fieldId}-note`} />
        <Button size="sm" disabled={!data || busy || !draft.trim()} onClick={() => { void submit() }}>
          {t(busy ? 'referrals.confirming' : 'referrals.confirm')}
        </Button>
      </div>
      <p id={`${fieldId}-note`} className="m-0 text-left text-[length:var(--font-caption)] text-[var(--muted-fg)]"
        role={status || failed ? 'alert' : undefined}>
        {status ? t(`referrals.status.${status}`) : t(failed ? 'referrals.unavailable' : 'referrals.optionalNote')}
      </p>
      {failed && <Button variant="ghost" size="sm" onClick={reload}>{t('referrals.retry')}</Button>}
    </div>
  )
}
