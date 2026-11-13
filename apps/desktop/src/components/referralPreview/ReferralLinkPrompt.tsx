import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices'
import { clearPersonalReferral, pendingPersonalReferral, REFERRAL_LINK_EVENT } from '@/lib/referralPending'
import { useAuth } from '../../store/auth'
import { Sheet } from '../ui/Sheet'
import { ReferralClaimField } from './ReferralClaimField'

export function ReferralLinkPrompt() {
  const { user } = useAuth()
  const { t } = useTranslation('main')
  const [owner, setOwner] = useState<string | null>(null)
  useEffect(() => {
    const check = () => {
      if (!user || !officialServicesEnabled()) return
      try { if (pendingPersonalReferral(user.id)) setOwner(user.id) }
      catch { setOwner(user.id) }
    }
    check()
    window.addEventListener(REFERRAL_LINK_EVENT, check)
    return () => window.removeEventListener(REFERRAL_LINK_EVENT, check)
  }, [user?.id])
  if (!user || owner !== user.id) return null
  const close = () => {
    try { clearPersonalReferral(user.id) } catch { /* User can still close the prompt. */ }
    setOwner(null)
  }
  return <Sheet open onClose={close} ariaLabel={t('referrals.confirm')} desktopWidth="440px">
    <div className="p-5"><ReferralClaimField key={user.id} userId={user.id} /></div>
  </Sheet>
}
