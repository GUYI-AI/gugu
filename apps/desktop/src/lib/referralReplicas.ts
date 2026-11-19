import { getMyReferral, getMyReferralActivity } from './referrals'
import { replica, replicaAccount } from './replica'

// Account-owned readings, no persistent copy and no push contract: reopen/refresh reads the server.
export const personalReferral = replica({ name: 'personalReferral', scope: 'account', read: getMyReferral, fresh: 0 })
export const personalReferralActivity = replica({
  name: 'personalReferralActivity', scope: 'account', fresh: 0,
  read: (owner: string, cursor: string | null) => getMyReferralActivity(owner, cursor),
})

export function refreshReferralReadings(userId: string): void {
  if (replicaAccount().id !== userId) return
  void personalReferral.refresh()
  void personalReferralActivity.refresh()
}
