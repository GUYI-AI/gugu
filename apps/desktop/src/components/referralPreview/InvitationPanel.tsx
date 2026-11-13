import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createReferralLink } from '@gugu/core/shared/referralLink'
import { platform } from '@/platform'
import { useAuth } from '../../store/auth'
import { Button } from '../ui/Button'
import { ReferralClaimField } from './ReferralClaimField'
import { useReferral } from './useReferral'

export function InvitationPanel() {
  const { user } = useAuth()
  const { t } = useTranslation('main')
  const { data, failed, reload } = useReferral(user?.id)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const copy = async (value: string) => {
    try { await platform.writeClipboardText(value); setCopyStatus(t('referrals.copied')) }
    catch { setCopyStatus(t('referrals.copyFailed')) }
  }
  return (
    <div className="flex flex-col gap-5 p-5" data-testid="referral-invitation">
      <div><h2 className="m-0 text-[length:var(--font-title)] font-semibold">{t('referralPreview.invite')}</h2>
        <p className="mb-0 mt-2 text-[length:var(--font-body)] text-[var(--muted-fg)]">{t('referralPreview.summary')}</p></div>
      <div className="rounded-[var(--radius-surface)] border border-[var(--border-subtle)] p-4">
        <div className="flex items-center justify-between gap-3"><span>{t('referralPreview.code')}</span>
          <strong>{data ? data.code : t(failed ? 'referrals.unavailable' : 'referrals.loading')}</strong></div>
        {data && <>
          <p className="mb-0 mt-3">{t('referrals.successCount', { count: data.successful_invitations })}</p>
          <p className="mb-0 mt-2 text-[var(--muted-fg)]">{t('referrals.earned', { amount: data.earned_cny })}</p>
          <p className="mb-0 mt-2 text-[length:var(--font-caption)] text-[var(--muted-fg)]">
            {t(`referrals.condition.${data.policy.success_condition}`)}</p>
          {!data.code_enabled && <p role="status">{t('referrals.codeDisabled')}</p>}
        </>}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" disabled={!data?.code_enabled}
          onClick={() => { if (data) void copy(data.code) }}>{t('referralPreview.copyCode')}</Button>
        <Button className="flex-1" disabled={!data?.code_enabled}
          onClick={() => { if (data) void copy(createReferralLink(data.code)) }}>{t('referralPreview.copyLink')}</Button>
      </div>
      {copyStatus && <p role="status" className="m-0">{copyStatus}</p>}
      <Button variant="ghost" size="sm" onClick={reload}>{t(failed ? 'referrals.retry' : 'referrals.refresh')}</Button>
      {user && <ReferralClaimField key={user.id} userId={user.id} />}
      <p className="m-0 text-[length:var(--font-caption)] text-[var(--muted-fg)]">{t('referralPreview.socialNote')}</p>
    </div>
  )
}
