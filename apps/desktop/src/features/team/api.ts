import type { Session } from '@supabase/supabase-js'
import { TeamApiError, teamStopReason } from './errors'
import * as read from './readers'
import type { TeamApi, TeamChoice, TeamRevocation, TeamSignInResult } from './types'
import { captureInvitationFailure, readInvitation } from './invitation-receipt'

export interface TeamRequest {
  endpoint: 'team-accounts' | 'team-billing'
  method: 'GET' | 'POST'
  action: string
  body?: Record<string, unknown>
  signal?: AbortSignal
  /** Only the isolated Google proof exchange overrides the current actor token. Never logged. */
  authorization?: string
}
export type TeamTransport = (request: TeamRequest) => Promise<unknown>

function choices(value: unknown): TeamChoice[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map(value => {
    const row = read.object(value, 'context choice')
    if (row.region !== 'cn' && row.region !== 'hk') throw new TeamApiError('invalid_response')
    return { team_id: read.text(row.team_id, 'team_id'), team_name: read.text(row.team_name, 'team_name'),
      role: read.role(row.role), member_state: read.memberState(row.member_state), region: row.region }
  })
}

function signIn(value: unknown): TeamSignInResult {
  const row = read.object(value, 'sign in'), team = read.object(row.team, 'team')
  const context = read.object(row.context, 'context'), session = read.object(row.session, 'session')
  const user = read.object(session.user, 'session.user')
  const metadata = read.object(user.app_metadata, 'session.user.app_metadata')
  // Do not attach the session to an Error or diagnostic payload if a contract check fails.
  read.text(session.access_token, 'session.access_token')
  read.text(session.refresh_token, 'session.refresh_token')
  read.text(user.id, 'session.user.id')
  if (metadata.gugu_account_kind !== 'team_member' || context.kind !== 'team'
    || (context.region !== 'cn' && context.region !== 'hk')) throw new TeamApiError('team_identity_required')
  const membership = read.membership(row.membership)
  if (team.id !== context.team_id || user.id !== membership.identity_id || membership.identity_id !== context.member_identity_id
    || membership.revision !== context.membership_revision || membership.state !== 'active') throw new TeamApiError('team_identity_required')
  return { team: { id: read.text(team.id, 'team.id'), name: read.text(team.name, 'team.name') },
    membership, context: { kind: 'team', region: context.region,
      team_id: read.text(context.team_id, 'team_id'), member_identity_id: read.text(context.member_identity_id, 'member_identity_id'),
      membership_revision: read.revision(context.membership_revision, 'membership_revision') }, session: session as unknown as Session }
}

function revocation(value: unknown, operationId?: string, requireChecks = false): TeamRevocation {
  const row = read.object(value, 'revocation')
  if (row.state !== 'revoking' && row.state !== 'complete') throw new TeamApiError('invalid_response')
  const checks = row.checks === undefined ? undefined : read.object(row.checks, 'revocation.checks')
  if (requireChecks && row.state === 'complete' && (!checks || checks.new_data_calls_denied !== true
    || checks.new_model_calls_denied !== true || checks.session_followups_stopped !== true)) throw new TeamApiError('revocation_pending')
  return { state: row.state, operation_id: read.text(row.operation_id ?? operationId, 'operation_id'),
    ...(typeof row.effective_at === 'string' ? { effective_at: row.effective_at } : {}),
    ...(checks ? { checks: { new_data_calls_denied: checks.new_data_calls_denied === true,
      new_model_calls_denied: checks.new_model_calls_denied === true, session_followups_stopped: checks.session_followups_stopped === true } } : {}) }
}

/** HTTP and test transports share one strict contract reader. No successful-empty error fallback. */
export function createTeamApi(transport: TeamTransport): TeamApi {
  async function call(request: TeamRequest, captureFailure?: (error: TeamApiError, data: unknown) => void): Promise<unknown> {
    const response = read.object(await transport(request), 'response')
    if (response.ok !== true) {
      const error = read.object(response.error, 'error')
      const refusal = new TeamApiError(read.text(error.code, 'error.code'),
        typeof response.status === 'number' ? response.status : undefined,
        teamStopReason(error.reason_code) ?? undefined,
        typeof error.retry_after_seconds === 'number' ? error.retry_after_seconds : undefined,
        choices(error.contexts))
      captureFailure?.(refusal, response.data)
      throw refusal
    }
    return response.data
  }
  const accounts = (action: string, body?: Record<string, unknown>, method: 'GET' | 'POST' = 'POST', signal?: AbortSignal) =>
    call({ endpoint: 'team-accounts', action, method, body, signal })
  const billing = (action: string, body?: Record<string, unknown>, method: 'GET' | 'POST' = 'GET', signal?: AbortSignal) =>
    call({ endpoint: 'team-billing', action, method, body, signal })
  return {
    async context(signal) { return read.currentContext(await billing('context', undefined, 'GET', signal)) },
    async challenge(input) {
      const row = read.object(await accounts('email_challenge', input), 'challenge')
      return { challenge_id: read.text(row.challenge_id, 'challenge_id'), expires_at: read.text(row.expires_at, 'expires_at'),
        resend_after_seconds: read.revision(row.resend_after_seconds, 'resend_after_seconds') }
    },
    async verify(challenge_id, code) {
      const row = read.object(await accounts('email_verify', { challenge_id, code }), 'verification')
      return { verification_receipt: read.text(row.verification_receipt, 'verification_receipt'), expires_at: read.text(row.expires_at, 'expires_at') }
    },
    async create(name, verification_receipt, idempotency_key) { return signIn(await accounts('create', { name, verification_receipt, idempotency_key })) },
    async signIn(verification_receipt, team_id) { return signIn(await accounts('sign_in', { verification_receipt, ...(team_id ? { team_id } : {}) })) },
    async googleSignIn(proof, team_id, signal) {
      return signIn(await call({ endpoint: 'team-accounts', action: 'google_sign_in', method: 'POST',
        authorization: `Bearer ${proof.access_token}`, body: team_id ? { team_id } : {}, signal }))
    },
    async profile(signal) { return read.profile(await accounts('profile', undefined, 'GET', signal)) },
    async directory(input, signal) { return read.directory(await accounts('directory', input, 'GET', signal)) },
    async members(input, signal) { return read.members(await accounts('members', input, 'GET', signal)) },
    async invite(email, idempotency_key) {
      return readInvitation(await call({ endpoint: 'team-accounts', action: 'invite', method: 'POST', body: { email, role: 'member', idempotency_key } }, captureInvitationFailure))
    },
    async invitationInfo(invitation_token) {
      const row = read.object(await accounts('invitation_info', { invitation_token }), 'invitation_info')
      if (row.state !== 'invited' || (row.region !== 'cn' && row.region !== 'hk')) throw new TeamApiError('invalid_response')
      return { invitation_id: read.text(row.invitation_id, 'invitation_id'), team_id: read.text(row.team_id, 'team_id'),
        team_name: read.text(row.team_name, 'team_name'), region: row.region, email_hint: read.text(row.email_hint, 'email_hint'),
        expires_at: read.text(row.expires_at, 'expires_at'), state: 'invited' }
    },
    async acceptInvitation(invitation_token, verification_receipt, idempotency_key) {
      return signIn(await accounts('accept_invitation', { invitation_token, verification_receipt, idempotency_key }))
    },
    async setRole(member_id, role, expected_revision, idempotency_key) {
      const row = read.object(await accounts('set_role', { member_id, role, expected_revision, idempotency_key }), 'role change')
      return { membership: read.membership(row.membership) }
    },
    async disable(member_id, handoff_member_id, expected_revision, idempotency_key) {
      const row = read.object(await accounts('disable', { member_id, handoff_member_id, expected_revision, idempotency_key }), 'disable')
      const changed = read.object(row.membership, 'membership'), handoff = read.object(row.handoff, 'handoff')
      if (changed.state !== 'disabled') throw new TeamApiError('invalid_response')
      return { membership: { state: 'disabled', revision: read.revision(changed.revision, 'revision') },
        handoff: { recipient_member_id: read.text(handoff.recipient_member_id, 'recipient_member_id') }, revocation: revocation(row.revocation) }
    },
    async revocationResult(operation_id) { return revocation(await accounts('revocation_result', { operation_id }), operation_id, true) },
    async restore(member_id, expected_revision, idempotency_key) {
      const row = read.object(await accounts('restore', { member_id, expected_revision, idempotency_key }), 'restore')
      const changed = read.object(row.membership, 'membership')
      if (changed.state !== 'active' || row.requires_sign_in !== true) throw new TeamApiError('invalid_response')
      return { membership: { state: 'active', revision: read.revision(changed.revision, 'revision') }, requires_sign_in: true }
    },
    async changeEmail(member_id, new_email, expected_revision, idempotency_key) {
      const row = read.object(await accounts('change_email', { member_id, new_email, expected_revision, idempotency_key }), 'email challenge')
      if (row.state !== 'pending') throw new TeamApiError('invalid_response')
      return { challenge_id: read.text(row.challenge_id, 'challenge_id'), expires_at: read.text(row.expires_at, 'expires_at'), state: 'pending' }
    },
    async confirmEmailChange(challenge_id, code, idempotency_key) {
      const row = read.object(await accounts('confirm_email_change', { challenge_id, code, idempotency_key }), 'email confirmation')
      if (row.state !== 'changed' || row.requires_sign_in !== true) throw new TeamApiError('invalid_response')
      return { state: 'changed', requires_sign_in: true }
    },
    async myUsage(input, signal) { return read.myUsage(await billing('my_usage', input, 'GET', signal)) },
    async summary(signal) { return read.summary(await billing('summary', undefined, 'GET', signal)) },
    async setCaps(members, idempotency_key) {
      if (!members.length || new Set(members.map(member => member.member_id)).size !== members.length) throw new TeamApiError('invalid_request')
      const row = read.object(await billing('set_caps', { members, idempotency_key }, 'POST'), 'set_caps')
      const results = read.list(row.members, 'members')
      const expected = new Set(members.map(member => member.member_id))
      if (results.length !== expected.size || results.some(value => !expected.delete(read.text(read.object(value, 'cap result').member_id, 'member_id')))) throw new TeamApiError('invalid_response')
      return { members: results.map(value => { const member = read.object(value, 'cap result'); return {
        member_id: read.text(member.member_id, 'member_id'), cap_credits: read.nullableCredits(member.cap_credits, 'cap_credits'),
        used_credits: read.credits(member.used_credits, 'used_credits'), revision: read.revision(member.revision, 'revision'),
        stop_reason: member.stop_reason === null ? null : teamStopReason(member.stop_reason) ?? (() => { throw new TeamApiError('invalid_response') })(),
      } }) }
    },
  }
}
