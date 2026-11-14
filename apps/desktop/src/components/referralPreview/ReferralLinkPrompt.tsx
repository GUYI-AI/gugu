import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices'
import { clearPersonalReferral, pendingPersonalReferral, REFERRAL_LINK_EVENT } from '@/lib/referralPending'
import { useAuth } from '../../store/auth'
import { Sheet } from '../ui/Sheet'
import { ReferralClaimField } from './ReferralClaimField'

export function ReferralLinkPrompt() {
  const { user } = useAuth()
  const userId = user?.id
  const { t } = useTranslation('main')
  const [owner, setOwner] = useState<string | null>(null)
  useEffect(() => {
    const check = () => {
      if (!userId || !officialServicesEnabled()) return
      try { if (pendingPersonalReferral(userId)) setOwner(userId) }
      catch { setOwner(userId) }
    }
    check()
    window.addEventListener(REFERRAL_LINK_EVENT, check)
    return () => window.removeEventListener(REFERRAL_LINK_EVENT, check)
  }, [userId])
  if (!user || owner !== user.id) return null
  const close = () => {
    try { clearPersonalReferral(user.id) } catch { /* User can still close the prompt. */ }
    setOwner(null)
  }
  return <Sheet open onClose={close} ariaLabel={t('referrals.confirm')} desktopWidth="440px">
    <div className="p-5"><ReferralClaimField key={user.id} userId={user.id} /></div>
  </Sheet>
}
