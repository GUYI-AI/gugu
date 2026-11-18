import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createReferralLinkForApp } from '@gugu/core/shared/referralLink'
import { guguLinkScheme } from '@gugu/core/shared/ui/guguLink'
import { platform } from '@/platform'
import { useAuth } from '../../store/auth'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'
import { ReferralClaimField } from './ReferralClaimField'
import { useReferral } from './useReferral'
import { useReferralActivity } from './useReferralActivity'
import { referralOffer } from './referralOffer'

declare const __GUGU_TIER__: string | undefined
// Stable keeps its existing path; Beta confirms the running native scheme when copying.
const betaBuild = guguLinkScheme({
  tier: typeof __GUGU_TIER__ === 'string' ? __GUGU_TIER__ : undefined, devLaunch: false,
}) === 'gugu-beta'

export function InvitationPanel() {
  const { user } = useAuth()
  const { t, i18n } = useTranslation('main')
  const { data, failed, reload } = useReferral(user?.id)
  const activity = useReferralActivity(user?.id)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const copy = async (value: string | Promise<string>) => {
    try { await platform.writeClipboardText(await value); setCopyStatus(t('referrals.copied')) }
    catch { setCopyStatus(t('referrals.copyFailed')) }
  }
  const offer = data ? referralOffer(data) : null
  return (
    <div className="gg-referral-panel" data-testid="referral-invitation">
      <div className="gg-referral-code-card">
        <span className="sr-only">{t('referralPreview.code')}</span>
        <strong className="gg-referral-code">{data ? data.code : t(failed ? 'referrals.unavailable' : 'referrals.loading')}</strong>
        {data && <p className="gg-referral-note">{t(`referrals.condition.${data.policy.success_condition}`)} {offer && t(`referrals.offer.${offer.key}`, offer)}</p>}
        <div className="gg-referral-copy">
          <Button variant="secondary" size="sm" disabled={!data?.code_enabled} onClick={() => { if (data) void copy(data.code) }}>{t('referralPreview.copyCode')}</Button>
          <Button variant="primary" size="sm" disabled={!data?.code_enabled} onClick={() => { if (data) void copy(createReferralLinkForApp(data.code, betaBuild ? platform.authCallbacks?.redirectTo : undefined)) }}>{t('referralPreview.copyLink')}</Button>
        </div>
        {data && !data.code_enabled && <p role="status">{t('referrals.codeDisabled')}</p>}
        {copyStatus && <p role="status" className="gg-referral-note">{copyStatus}</p>}
      </div>
      <div className="gg-referral-stats">
        <div><strong>{data ? t('referrals.people', { count: data.successful_invitations }) : '—'}</strong><span>{t('referrals.invited')}</span></div>
        <div><strong>{data ? t('referrals.credits', { amount: data.earned_cny.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') }) : '—'}</strong><span>{t('referrals.received')}</span></div>
      </div>
      <div className="gg-referral-activity-heading"><span>{t('referrals.history')}</span>
        <Button variant="ghost" size="sm" onClick={() => { reload(); activity.reload() }}>{t(failed ? 'referrals.retry' : 'referrals.refresh')}</Button></div>
      <div className="gg-referral-activity" data-testid="referral-activity">
        {activity.items.map(item => <div className="gg-referral-activity-row" key={item.key}>
          <Avatar name={item.display_name || t('referrals.friend')} avatarUrl={item.avatar} seed={item.key} size={28} isAgent={false} />
          <span className="gg-referral-friend">{item.display_name || t('referrals.friend')}</span>
          <time dateTime={item.invited_at}>{new Intl.DateTimeFormat(i18n.resolvedLanguage, { month: '2-digit', day: '2-digit' }).format(new Date(item.invited_at))}</time>
          <span className={item.credited ? 'gg-referral-paid' : 'gg-referral-pending'}>{item.credited ? '+' + item.credited_cny.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : t(`referrals.activity.${item.state}`)}</span>
        </div>)}
        {activity.loading && <p role="status" className="gg-referral-note">{t('referrals.loading')}</p>}
        {activity.failed && <div role="alert"><p className="gg-referral-note">{t('referrals.historyUnavailable')}</p><Button variant="ghost" size="sm" onClick={activity.loadMore}>{t('referrals.retry')}</Button></div>}
        {!activity.loading && !activity.failed && activity.items.length === 0 && <p className="gg-referral-note">{t('referrals.emptyHistory')}</p>}
        {activity.more && !activity.failed && <Button variant="ghost" size="sm" disabled={activity.loading} onClick={activity.loadMore}>{t('referrals.more')}</Button>}
      </div>
      {user && data?.claim_available && <ReferralClaimField key={user.id} userId={user.id} />}
    </div>
  )
}
