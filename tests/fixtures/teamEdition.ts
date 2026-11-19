import { creditDecimal as cd, creditFromUnits, creditUnits } from '@gugu/core/billing/creditAmount'
import type { AuthUser } from '../../apps/desktop/src/store/auth'
import type { TeamApi, TeamRole, TeamSignInResult, TeamProfile, CurrentTeamContext, TeamMember, TeamInvitation } from '../../apps/desktop/src/features/team/types'
import { TeamApiError } from '../../apps/desktop/src/features/team/errors'

export const teamInvitationCapability = 'synthetic-team-invitation-'.repeat(2)
export function teamInvitationFixture(): TeamInvitation {
  const fragment = `?region=cn#invitation_token=${teamInvitationCapability}`
  return { invitation_id: 'invitation-fixture', state: 'invited', expires_at: '2099-11-01T00:05:00Z',
    operation_id: 'identity-operation-fixture', invitation_created: true,
    delivery: { operation_id: 'mail-operation-fixture', state: 'accepted', reason_code: 'smtp_accepted' },
    invitation_url: `https://website.example.test/team/invite${fragment}`,
    app_deep_links: { stable: `gugu://team/invite${fragment}`, beta: `gugu-beta://team/invite${fragment}`, dev: `gugu-dev://team/invite${fragment}` } }
}

export const teamUser: AuthUser = { id: 'team-person-lin', accountKind: 'team_member', nickname: '林晓', email: 'lin@example.test', bio: '', gugu_number: 635812 }
export const teamMonth = { starts_at: '2026-10-31T16:00:00Z', ends_at: '2026-11-30T16:00:00Z', timezone: 'Asia/Shanghai' as const, label: '2026-11' }
export const teamPeople: (TeamMember & { gugu_number: number })[] = [
  { id: 'member-lin', gugu_number: 635812, identity_id: teamUser.id, name: '林晓', email: teamUser.email, role: 'member', state: 'active', revision: 93 },
  { id: 'member-zhou', gugu_number: 635813, identity_id: 'team-person-zhou', name: '周宁', email: 'zhou@example.test', role: 'superadmin', state: 'active', revision: 4 },
  { id: 'member-xu', gugu_number: 635814, identity_id: 'team-person-xu', name: '许澄', email: 'xu@example.test', role: 'member', state: 'active', revision: 5 },
  { id: 'member-wang', gugu_number: 635815, identity_id: 'team-person-wang', name: '王乔', email: 'wang@example.test', role: 'member', state: 'disabled', revision: 8 },
]
export function teamContext(role: TeamRole = 'member'): CurrentTeamContext {
  return { kind: 'team', region: 'cn', team_id: 'team-ming', team_name: '明川研究院', member_id: 'member-lin', member_identity_id: teamUser.id,
    membership_revision: 93, role, member_state: 'active', cap_credits: cd('200'), used_credits: cd('126'), cap_revision: 17, scope: teamMonth, stop_reason: null }
}
export function teamProfile(role: TeamRole = 'member'): TeamProfile {
  return { realtime_namespace: 'synthetic-opaque-auth-session:', membership_revision: 93,
    team: { id: 'team-ming', name: '明川研究院' }, membership: { ...teamPeople[0], identity_id: teamUser.id, role },
    profile: { name: teamUser.nickname, email: teamUser.email, avatar: null, bio: '' }, entitlements: { tier: 'plus' }, pending_email_change: null }
}
export function teamSignIn(role: TeamRole = 'member'): TeamSignInResult {
  return { team: teamProfile(role).team, membership: teamProfile(role).membership, context: teamContext(role),
    session: { access_token: 'synthetic-team-access', refresh_token: 'synthetic-team-refresh', token_type: 'bearer', expires_in: 3600,
      user: { id: teamUser.id, app_metadata: { gugu_account_kind: 'team_member' }, user_metadata: {}, aud: 'authenticated', created_at: '2026-11-01T00:00:00Z' } } }
}
/** All fixture IDs/emails/tokens are synthetic. The production provider defaults to the regional HTTP API. */
export function mockTeamApi(role: TeamRole = 'member', overrides: Partial<TeamApi> = {}): TeamApi {
  const people = teamPeople.map(person => ({ ...person, ...(person.id === 'member-lin' ? { role } : {}) }))
  const caps = people.map((person, index) => ({ member_id: person.id, cap_credits: index === 3 ? null : cd(['200', '150', '100'][index]),
    used_credits: cd(['126', '80', '24', '40'][index]), cap_revision: 17 + index, scope: teamMonth }))
  const own = () => caps[0]
  const stop = () => own().cap_credits !== null && creditUnits(own().cap_credits!) <= creditUnits(own().used_credits) ? 'team_member_monthly_cap_reached' as const : null
  return {
    context: async () => ({ ...teamContext(role), cap_credits: own().cap_credits, cap_revision: own().cap_revision, stop_reason: stop() }), profile: async () => teamProfile(role),
    challenge: async () => ({ challenge_id: 'challenge-fixture', expires_at: '2099-11-01T00:05:00Z', resend_after_seconds: 0 }),
    verify: async () => ({ verification_receipt: 'receipt-fixture', expires_at: '2099-11-01T00:05:00Z' }),
    create: async () => teamSignIn('superadmin'), signIn: async () => teamSignIn(role), googleSignIn: async () => teamSignIn(role),
    directory: async input => ({ members: people.filter(person => person.state === 'active' && (!input?.query || person.name.includes(input.query))).map(person => ({ identity_id: person.identity_id!, name: person.name, avatar: null, role: person.role })), next_cursor: null }),
    members: async input => ({ members: people.filter(person => person.state === input.state).map(person => ({ ...person })), next_cursor: null }),
    invite: async () => teamInvitationFixture(),
    invitationInfo: async () => ({ invitation_id: 'invitation-fixture', team_id: 'team-ming', team_name: '明川研究院', region: 'cn', email_hint: 'l***@example.test', expires_at: '2099-11-01T00:05:00Z', state: 'invited' }),
    acceptInvitation: async () => teamSignIn(role),
    setRole: async (id, next, revision) => { const person = people.find(person => person.id === id)!; person.role = next; person.revision = revision + 1
      return { membership: { ...person, identity_id: person.identity_id!, role: next, revision: revision + 1 } } },
    disable: async id => { const person = people.find(person => person.id === id)!; person.state = 'disabled'; person.revision++
      return { membership: { state: 'disabled', revision: person.revision }, handoff: { recipient_member_id: 'member-zhou' }, revocation: { state: 'revoking', operation_id: 'revocation-fixture' } } },
    revocationResult: async () => ({ state: 'complete', operation_id: 'revocation-fixture', checks: { new_data_calls_denied: true, new_model_calls_denied: true, session_followups_stopped: true } }),
    restore: async (_id, revision) => ({ membership: { state: 'active', revision: revision + 1 }, requires_sign_in: true }),
    changeEmail: async () => ({ challenge_id: 'change-fixture', expires_at: '2099-11-01T00:05:00Z', state: 'pending' }),
    confirmEmailChange: async () => ({ state: 'changed', requires_sign_in: true }),
    myUsage: async () => ({ used_credits: own().used_credits, cap_credits: own().cap_credits,
      headroom_credits: own().cap_credits === null ? null : creditFromUnits(creditUnits(own().cap_credits!) > creditUnits(own().used_credits) ? creditUnits(own().cap_credits!) - creditUnits(own().used_credits) : 0n), scope: teamMonth, stop_reason: stop(),
      records: [{ id: 'record-fixture', occurred_at: '2026-11-14T06:00:00Z', label: '模型调用', credits: cd('0.4') }], next_cursor: null }),
    summary: async () => ({ team_balance_credits: cd('1236'), unit: { version: 2, currency: 'CNY', face_value: 1 }, revision: 7,
      members: caps.map(cap => ({ ...cap })) }),
    directorySummary: async input => {
      const active = people.filter(person => person.state === 'active')
      const query = input?.query?.trim().toLowerCase()
      const matched = active.filter(person => !query || person.name.toLowerCase().includes(query)
        || (/^[0-9]{1,9}$/.test(query) && person.gugu_number === Number(query))
        || (role !== 'member' && person.email.toLowerCase().includes(query)))
      const after = input?.cursor ? matched.findIndex(person => person.id === input.cursor) + 1 : 0
      const selected = matched.slice(after, after + (input?.limit ?? 50))
      return { team_id: 'team-ming', team_name: '明川研究院', total_count: active.length, matching_count: matched.length,
        team_balance_credits: cd('1236'), billing_revision: 7, scope: teamMonth, unit: { version: 2, currency: 'CNY', face_value: 1 },
        members: selected.map(person => { const cap = caps.find(cap => cap.member_id === person.id)!; return {
          id: person.id, identity_id: person.identity_id!, name: person.name, avatar: null, role: person.role, gugu_number: person.gugu_number,
          revision: person.revision, membership_revision: person.revision, ...(role !== 'member' ? { email: person.email } : {}),
          used_credits: cap.used_credits, cap_credits: cap.cap_credits, cap_revision: cap.cap_revision, stop_reason: null,
        } }), next_cursor: after + selected.length < matched.length ? selected.at(-1)!.id : null }
    },
    setCaps: async members => {
      if (members.some(member => caps.find(cap => cap.member_id === member.member_id)?.cap_revision !== member.expected_revision)) throw new TeamApiError('version_conflict')
      for (const member of members) { const cap = caps.find(cap => cap.member_id === member.member_id)!; cap.cap_credits = member.cap_credits; cap.cap_revision++ }
      return { members: members.map(member => ({ member_id: member.member_id, cap_credits: member.cap_credits, used_credits: caps.find(cap => cap.member_id === member.member_id)!.used_credits, revision: member.expected_revision + 1, stop_reason: null })) }
    },
    ...overrides,
  }
}
