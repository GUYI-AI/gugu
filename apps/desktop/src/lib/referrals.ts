import { dataClient, getCurrentAuthUserId } from './supabase'

export interface ReferralSummary {
  status: 'ok'
  code: string
  code_enabled: boolean
  successful_invitations: number
  rewarded_invitations: number
  earned_cny: string
  claim_available: boolean
  claim_deadline: string
  attribution: { code: string; qualified: boolean; reward_state: string } | null
  policy: {
    rewards_enabled: boolean
    credits_each_cny: string
    recipients: 'both' | 'inviter' | 'invitee'
    success_condition: 'verified_login' | 'first_message'
    max_rewards_per_inviter: number | null
  }
}

/** Deliberately reject missing fields. A failed read never becomes zero invitations. */
export function readReferralSummary(value: unknown): ReferralSummary {
  const row = value as ReferralSummary | null
  if (!row || row.status !== 'ok' || !/^[A-F0-9]{12}$/.test(row.code)
    || typeof row.code_enabled !== 'boolean' || typeof row.claim_available !== 'boolean'
    || !Number.isSafeInteger(row.successful_invitations) || row.successful_invitations < 0
    || !Number.isSafeInteger(row.rewarded_invitations) || row.rewarded_invitations < 0
    || typeof row.earned_cny !== 'string' || !/^\d+(?:\.\d+)?$/.test(row.earned_cny)
    || !row.policy || typeof row.policy.rewards_enabled !== 'boolean'
    || typeof row.policy.credits_each_cny !== 'string' || !/^\d+(?:\.\d+)?$/.test(row.policy.credits_each_cny)
    || !['both','inviter','invitee'].includes(row.policy.recipients)
    || !['verified_login','first_message'].includes(row.policy.success_condition)
    || !(row.policy.max_rewards_per_inviter === null || Number.isSafeInteger(row.policy.max_rewards_per_inviter))) {
    throw new Error('Referral service returned an invalid response')
  }
  return row
}

export async function getMyReferral(expectedUserId: string): Promise<ReferralSummary> {
  if (await getCurrentAuthUserId() !== expectedUserId) throw new Error('Referral account changed')
  const { data, error } = await dataClient.schema('billing').rpc('referral_me')
  if (error) throw error
  if (await getCurrentAuthUserId() !== expectedUserId) throw new Error('Referral account changed')
  return readReferralSummary(data)
}

export async function claimMyReferral(expectedUserId: string, code: string): Promise<string> {
  if (await getCurrentAuthUserId() !== expectedUserId) throw new Error('Referral account changed')
  const { data, error } = await dataClient.schema('billing').rpc('referral_claim', { p_code: code })
  if (error) throw error
  if (await getCurrentAuthUserId() !== expectedUserId) throw new Error('Referral account changed')
  const status = (data as { status?: unknown } | null)?.status
  if (typeof status !== 'string' || !['attributed','already_attributed','source_locked','claim_expired','invalid_code','self_invite','not_eligible'].includes(status)) {
    throw new Error('Referral claim returned an invalid response')
  }
  return status
}
