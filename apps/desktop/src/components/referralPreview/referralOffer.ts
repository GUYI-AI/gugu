import type { ReferralSummary } from '@/lib/referrals'

export function referralOffer(data: ReferralSummary) {
  const amount = data.policy.credits_each_cny.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return { key: data.policy.rewards_enabled ? data.policy.recipients : 'off', amount }
}
