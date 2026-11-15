import { creditDecimal, creditUnits } from '@gugu/core/billing/creditAmount'
import { TeamResponseError, teamStopReason } from './errors'
import { verifiedTeamRealtimeScope } from '../../../shared/team-realtime'
import type {
  CurrentAccountContext, CurrentTeamContext, MyTeamUsage, TeamBillingSummary, TeamDirectoryMember,
  TeamMember, TeamMemberState, TeamMembership, TeamMonthScope, TeamPageResult, TeamProfile, TeamRole,
} from './types'

export function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeamResponseError(field)
  return value as Record<string, unknown>
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TeamResponseError(field)
  return value
}
export function nullableText(value: unknown, field: string): string | null {
  if (value === null || typeof value === 'string') return value
  throw new TeamResponseError(field)
}
export function revision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TeamResponseError(field)
  return value
}
export function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TeamResponseError(field)
  return value
}
export function credits(value: unknown, field: string) {
  try { return creditDecimal(value) } catch { throw new TeamResponseError(field) }
}
export function nullableCredits(value: unknown, field: string) {
  return value === null ? null : credits(value, field)
}
export function role(value: unknown): TeamRole {
  if (value !== 'superadmin' && value !== 'admin' && value !== 'member') throw new TeamResponseError('role')
  return value
}
export function memberState(value: unknown): TeamMemberState {
  if (value !== 'active' && value !== 'disabled' && value !== 'invited' && value !== 'provisioning') throw new TeamResponseError('state')
  return value
}
export function monthScope(value: unknown): TeamMonthScope {
  const row = object(value, 'scope')
  const starts_at = text(row.starts_at, 'scope.starts_at'), ends_at = text(row.ends_at, 'scope.ends_at')
  const label = text(row.label, 'scope.label')
  if (row.timezone !== 'Asia/Shanghai' || !/^\d{4}-\d{2}$/.test(label)
    || !Number.isFinite(Date.parse(starts_at)) || !Number.isFinite(Date.parse(ends_at))
    || Date.parse(ends_at) <= Date.parse(starts_at)) throw new TeamResponseError('scope')
  return { starts_at, ends_at, label, timezone: 'Asia/Shanghai' }
}
function stop(value: unknown) {
  if (value === null) return null
  const result = teamStopReason(value)
  if (!result) throw new TeamResponseError('stop_reason')
  return result
}
export function currentContext(value: unknown): CurrentAccountContext {
  const row = object(value, 'context')
  if (row.kind === 'personal') return { kind: 'personal' }
  if (row.kind !== 'team' || (row.region !== 'cn' && row.region !== 'hk')) throw new TeamResponseError('context.kind')
  return {
    kind: 'team', region: row.region, team_id: text(row.team_id, 'team_id'), team_name: text(row.team_name, 'team_name'),
    member_id: text(row.member_id, 'member_id'), member_identity_id: text(row.member_identity_id, 'member_identity_id'),
    membership_revision: revision(row.membership_revision, 'membership_revision'), role: role(row.role),
    member_state: memberState(row.member_state), cap_credits: nullableCredits(row.cap_credits, 'cap_credits'),
    used_credits: credits(row.used_credits, 'used_credits'), cap_revision: revision(row.cap_revision, 'cap_revision'),
    scope: monthScope(row.scope), stop_reason: stop(row.stop_reason),
  } satisfies CurrentTeamContext
}
export function membership(value: unknown): TeamMembership {
  const row = object(value, 'membership')
  return { id: text(row.id, 'membership.id'), identity_id: text(row.identity_id, 'membership.identity_id'),
    role: role(row.role), state: memberState(row.state), revision: revision(row.revision, 'membership.revision') }
}
export function profile(value: unknown): TeamProfile {
  const row = object(value, 'profile'), team = object(row.team, 'team'), person = object(row.profile, 'profile.profile')
  const member = membership(row.membership), membership_revision = revision(row.membership_revision, 'membership_revision')
  const realtime_namespace = text(row.realtime_namespace, 'realtime_namespace')
  if (member.revision !== membership_revision) throw new TeamResponseError('membership_revision')
  verifiedTeamRealtimeScope({ teamId: text(team.id, 'team.id'), memberId: member.id, membershipRevision: membership_revision, namespace: realtime_namespace })
  const pending = row.pending_email_change == null ? null : object(row.pending_email_change, 'pending_email_change')
  return { realtime_namespace, membership_revision, team: { id: text(team.id, 'team.id'), name: text(team.name, 'team.name') }, membership: member,
    profile: { name: text(person.name, 'profile.name'), avatar: nullableText(person.avatar, 'profile.avatar'),
      bio: nullableText(person.bio, 'profile.bio'), email: text(person.email, 'profile.email') }, entitlements: object(row.entitlements, 'entitlements'),
    pending_email_change: pending ? { challenge_id: text(pending.challenge_id, 'challenge_id'), new_email: text(pending.new_email, 'new_email'), expires_at: text(pending.expires_at, 'expires_at') } : null }
}
export function directory(value: unknown): TeamPageResult<TeamDirectoryMember> {
  const row = object(value, 'directory')
  return { members: list(row.members, 'members').map(value => { const member = object(value, 'member'); return {
    identity_id: text(member.identity_id, 'identity_id'), name: text(member.name, 'name'),
    avatar: nullableText(member.avatar, 'avatar'), role: role(member.role),
  } }), next_cursor: nullableText(row.next_cursor, 'next_cursor') }
}
export function members(value: unknown): TeamPageResult<TeamMember> {
  const row = object(value, 'members')
  return { members: list(row.members, 'members').map(value => {
    const member = object(value, 'member'), state = memberState(member.state), identity_id = nullableText(member.identity_id, 'identity_id')
    if (state === 'active' && !identity_id) throw new TeamResponseError('identity_id')
    return {
    id: text(member.id, 'member.id'), identity_id, state, role: role(member.role), revision: revision(member.revision, 'revision'),
    name: text(member.name, 'name'), email: text(member.email, 'email'),
  } }), next_cursor: nullableText(row.next_cursor, 'next_cursor') }
}
export function myUsage(value: unknown): MyTeamUsage {
  const row = object(value, 'my_usage')
  return { used_credits: credits(row.used_credits, 'used_credits'), cap_credits: nullableCredits(row.cap_credits, 'cap_credits'),
    headroom_credits: nullableCredits(row.headroom_credits, 'headroom_credits'), scope: monthScope(row.scope), stop_reason: stop(row.stop_reason),
    records: list(row.records, 'records').map(value => { const entry = object(value, 'usage record')
      const occurred_at = text(entry.occurred_at, 'record.occurred_at'), amount = credits(entry.credits, 'record.credits')
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/.test(occurred_at) || !Number.isFinite(Date.parse(occurred_at)) || creditUnits(amount) <= 0n) throw new TeamResponseError('record')
      return {
      id: text(entry.id, 'record.id'), occurred_at,
      label: text(entry.label, 'record.label'), credits: amount,
    } }), next_cursor: nullableText(row.next_cursor, 'next_cursor') }
}
export function summary(value: unknown): TeamBillingSummary {
  const row = object(value, 'summary'), unit = object(row.unit, 'unit')
  if (unit.version !== 2 || unit.currency !== 'CNY' || unit.face_value !== 1) throw new TeamResponseError('unit')
  return { team_balance_credits: credits(row.team_balance_credits, 'team_balance_credits'), unit: { version: 2, currency: 'CNY', face_value: 1 },
    revision: revision(row.revision, 'revision'), members: list(row.members, 'members').map(value => {
      const member = object(value, 'member usage')
      return { member_id: text(member.member_id, 'member_id'), used_credits: credits(member.used_credits, 'used_credits'),
        cap_credits: nullableCredits(member.cap_credits, 'cap_credits'), cap_revision: revision(member.cap_revision, 'cap_revision'), scope: monthScope(member.scope) }
    }) }
}
