import type { Session } from '@supabase/supabase-js'
import type { CreditDecimal } from '@gugu/core/billing/creditAmount'

/** Wire names follow team-edition-v1.md. Team money never uses a personal wallet. */
export type TeamRole = 'superadmin' | 'admin' | 'member'
export type TeamMemberState = 'active' | 'disabled' | 'invited' | 'provisioning'
export type TeamStopReason = 'team_member_monthly_cap_reached' | 'team_credits_exhausted'
export type TeamAccountKind = 'personal' | 'team_member' | 'team_login_anchor' | 'unknown'

export interface TeamDescriptor { id: string; name: string }
export interface TeamMembership {
  id: string
  identity_id: string
  role: TeamRole
  state: TeamMemberState
  revision: number
}
export interface TeamContext {
  kind: 'team'
  region: 'cn' | 'hk'
  team_id: string
  member_identity_id: string
  membership_revision: number
}
export interface CurrentTeamContext extends TeamContext {
  team_name: string
  member_id: string
  role: TeamRole
  member_state: TeamMemberState
  cap_credits: CreditDecimal | null
  used_credits: CreditDecimal
  cap_revision: number
  scope: TeamMonthScope
  stop_reason: TeamStopReason | null
}
export type CurrentAccountContext = { kind: 'personal' } | CurrentTeamContext
export interface TeamProfile {
  realtime_namespace: string
  membership_revision: number
  team: TeamDescriptor
  membership: TeamMembership
  profile: { name: string; avatar: string | null; bio: string | null; email: string }
  entitlements: Record<string, unknown>
  pending_email_change: { challenge_id: string; new_email: string; expires_at: string } | null
}
export interface TeamInvitationReceipt {
  operation_id: string | null
  invitation_created: boolean | null
  delivery: { operation_id: string | null; state: 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown'; reason_code: string | null }
}
export interface TeamInvitation extends TeamInvitationReceipt {
  operation_id: string
  invitation_created: true
  invitation_id: string
  state: 'invited'
  expires_at: string
  invitation_url: string
  app_deep_links: { stable: string; beta: string; dev: string }
}
export interface TeamInvitationInfo { invitation_id: string; team_id: string; team_name: string; region: 'cn' | 'hk'; email_hint: string; expires_at: string; state: 'invited' }
export interface TeamSignInResult {
  team: TeamDescriptor
  membership: TeamMembership
  context: TeamContext
  session: Session
}
export interface TeamChallenge { challenge_id: string; expires_at: string; resend_after_seconds: number }
export interface TeamVerification { verification_receipt: string; expires_at: string }
export interface TeamChoice { team_id: string; team_name: string; role: TeamRole; member_state: TeamMemberState; region: 'cn' | 'hk' }
export interface TeamDirectoryMember { identity_id: string; name: string; avatar: string | null; role: TeamRole }
export interface TeamMember extends Omit<TeamMembership, 'identity_id'> { identity_id: string | null; name: string; email: string }
export interface TeamPageResult<T> { members: T[]; next_cursor: string | null }
export interface TeamMonthScope { starts_at: string; ends_at: string; timezone: 'Asia/Shanghai'; label: string }
export interface TeamUsageRecord {
  id: string
  occurred_at: string
  label: string
  credits: CreditDecimal
}
export interface MyTeamUsage {
  used_credits: CreditDecimal
  cap_credits: CreditDecimal | null
  headroom_credits: CreditDecimal | null
  scope: TeamMonthScope
  stop_reason: TeamStopReason | null
  records: TeamUsageRecord[]
  next_cursor: string | null
}
export interface TeamMemberUsage {
  member_id: string
  used_credits: CreditDecimal
  cap_credits: CreditDecimal | null
  /** Financial cap revision, never membership.revision. Zero means not configured. */
  cap_revision: number
  scope: TeamMonthScope
}
export interface TeamBillingSummary {
  team_balance_credits: CreditDecimal
  unit: { version: 2; currency: 'CNY'; face_value: 1 }
  members: TeamMemberUsage[]
  revision: number
}
export interface TeamCapChange { member_id: string; cap_credits: CreditDecimal | null; expected_revision: number }
export interface TeamCapResult {
  member_id: string
  cap_credits: CreditDecimal | null
  used_credits: CreditDecimal
  revision: number
  stop_reason: TeamStopReason | null
}
export interface TeamRevocation {
  state: 'revoking' | 'complete'
  operation_id: string
  effective_at?: string
  checks?: { new_data_calls_denied: boolean; new_model_calls_denied: boolean; session_followups_stopped: boolean }
}
export interface TeamDisableResult {
  membership: { state: 'disabled'; revision: number }
  handoff: { recipient_member_id: string }
  revocation: TeamRevocation
}

/** Injectable at feature boundaries for component tests; production uses the HTTP adapter. */
export interface TeamApi {
  context(signal?: AbortSignal): Promise<CurrentAccountContext>
  challenge(input: { email: string; purpose: 'create' | 'sign_in' | 'accept_invitation'; team_id?: string; invitation_token?: string }): Promise<TeamChallenge>
  verify(challenge_id: string, code: string): Promise<TeamVerification>
  create(name: string, verification_receipt: string, idempotency_key: string): Promise<TeamSignInResult>
  signIn(verification_receipt: string, team_id?: string): Promise<TeamSignInResult>
  googleSignIn(proof: Pick<Session, 'access_token'>, team_id?: string, signal?: AbortSignal): Promise<TeamSignInResult>
  profile(signal?: AbortSignal): Promise<TeamProfile>
  directory(input?: { query?: string; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<TeamPageResult<TeamDirectoryMember>>
  members(input: { state: Exclude<TeamMemberState, 'provisioning'>; query?: string; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<TeamPageResult<TeamMember>>
  invite(email: string, idempotency_key: string): Promise<TeamInvitation>
  invitationInfo(invitation_token: string): Promise<TeamInvitationInfo>
  acceptInvitation(invitation_token: string, verification_receipt: string, idempotency_key: string): Promise<TeamSignInResult>
  setRole(member_id: string, role: 'admin' | 'member', expected_revision: number, idempotency_key: string): Promise<{ membership: TeamMembership }>
  disable(member_id: string, handoff_member_id: string | undefined, expected_revision: number, idempotency_key: string): Promise<TeamDisableResult>
  revocationResult(operation_id: string): Promise<TeamRevocation>
  restore(member_id: string, expected_revision: number, idempotency_key: string): Promise<{ membership: { state: 'active'; revision: number }; requires_sign_in: true }>
  changeEmail(member_id: string, new_email: string, expected_revision: number, idempotency_key: string): Promise<{ challenge_id: string; expires_at: string; state: 'pending' }>
  confirmEmailChange(challenge_id: string, code: string, idempotency_key: string): Promise<{ state: 'changed'; requires_sign_in: true }>
  myUsage(input?: { cursor?: string; limit?: number }, signal?: AbortSignal): Promise<MyTeamUsage>
  summary(signal?: AbortSignal): Promise<TeamBillingSummary>
  setCaps(members: TeamCapChange[], idempotency_key: string): Promise<{ members: TeamCapResult[] }>
}
