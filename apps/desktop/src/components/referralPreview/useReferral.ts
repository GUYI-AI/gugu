import { useEffect, useState } from 'react'
import { getMyReferral, type ReferralSummary } from '@/lib/referrals'
import { REFERRAL_CHANGED_EVENT } from '@/lib/referralPending'

export function useReferral(userId: string | undefined) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ userId?: string; data?: ReferralSummary; failed?: boolean }>({})
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === userId) setRevision(value => value + 1)
    }
    window.addEventListener(REFERRAL_CHANGED_EVENT, changed)
    return () => window.removeEventListener(REFERRAL_CHANGED_EVENT, changed)
  }, [userId])
  useEffect(() => {
    if (!userId) return
    let active = true
    setState({ userId })
    getMyReferral(userId).then(data => { if (active) setState({ userId, data }) },
      () => { if (active) setState({ userId, failed: true }) })
    return () => { active = false }
  }, [userId, revision])
  return {
    data: state.userId === userId ? state.data : undefined,
    failed: state.userId === userId && state.failed,
    reload: () => setRevision(value => value + 1),
  }
}
