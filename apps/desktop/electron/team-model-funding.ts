import type { RuntimeAuth } from '@gugu/core'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { teamAccountTokenHint } from '../shared/team-account-claims'
import { teamCreditStopReason, type TeamCreditStopReason } from '@gugu/session-core/session-record/team-credits'

export interface TeamTaskFunding {
  kind: 'team'
  team_id: string
  member_id: string
  task_id: string
  unit_version: 2
  locked_at: string
}
export interface TeamTaskIdentity { actorUserId: string; memberIdentityId: string; funding: TeamTaskFunding }
export class TeamFundingError extends Error {
  constructor(readonly code: string, readonly reason_code?: TeamCreditStopReason) { super('Team model access was refused'); this.name = 'TeamFundingError' }
}
export function teamModelStopReason(error: unknown): TeamCreditStopReason | null {
  const seen = new Set<object>(), pending = [error]
  while (pending.length) {
    const item = pending.shift()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    const row = item as Record<string, unknown>, reason = teamCreditStopReason(row.reason_code)
    if (row.code === 'credits_exhausted' && reason) return reason
    pending.push(row.error, row.cause)
  }
  return null
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TeamFundingError('team_identity_required')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new TeamFundingError('team_identity_required')
  return value
}
export function parseTeamTaskFunding(value: unknown): TeamTaskFunding {
  const row = record(value)
  if (row.kind !== 'team' || row.unit_version !== 2 || !Number.isFinite(Date.parse(text(row.locked_at)))) throw new TeamFundingError('team_identity_required')
  return { kind: 'team', team_id: text(row.team_id), member_id: text(row.member_id), task_id: text(row.task_id), unit_version: 2, locked_at: text(row.locked_at) }
}
export function assertSameTeamFunding(actual: TeamTaskFunding, expected: TeamTaskFunding) {
  if (actual.team_id !== expected.team_id || actual.member_id !== expected.member_id || actual.task_id !== expected.task_id
    || actual.unit_version !== expected.unit_version || actual.locked_at !== expected.locked_at) throw new TeamFundingError('team_identity_required')
}
export function assertTeamTaskActor(auth: RuntimeAuth, expected?: TeamTaskIdentity) {
  if (expected && (auth.userId !== expected.actorUserId || teamAccountTokenHint(auth.accessToken) !== 'team')) throw new TeamFundingError('team_identity_required')
}

type TeamFetch = (url: string, init: RequestInit) => Promise<Response>
export async function readTeamModelContext(auth: RuntimeAuth, fetchImpl: TeamFetch) {
  const response = await fetchImpl(`${getSupabaseUrl().replace(/\/$/, '')}/functions/v1/team-billing?action=context`, {
    method: 'GET', headers: { apikey: getSupabaseAnonKey(), Authorization: `Bearer ${auth.accessToken}` }, signal: AbortSignal.timeout(15_000),
  })
  const envelope = record(await response.json().catch(() => null))
  if (!response.ok || envelope.ok !== true) {
    const error = record(envelope.error)
    throw new TeamFundingError(typeof error.code === 'string' ? error.code : 'billing_unavailable', teamCreditStopReason(error.reason_code) ?? undefined)
  }
  const row = record(envelope.data)
  if (row.kind !== 'team' || row.member_state !== 'active' || !Number.isSafeInteger(row.membership_revision) || Number(row.membership_revision) < 0) throw new TeamFundingError(row.member_state === 'disabled' ? 'membership_disabled' : 'team_identity_required')
  return { teamId: text(row.team_id), memberId: text(row.member_id), memberIdentityId: text(row.member_identity_id),
    membershipRevision: row.membership_revision as number, stopReason: teamCreditStopReason(row.stop_reason) }
}

export async function teamIssueContext(auth: RuntimeAuth, taskId: string, fetchImpl: TeamFetch, expected?: TeamTaskIdentity) {
  assertTeamTaskActor(auth, expected)
  const hint = teamAccountTokenHint(auth.accessToken)
  if (hint === 'personal') return null
  if (hint !== 'team') throw new TeamFundingError('team_identity_required')
  const context = await readTeamModelContext(auth, fetchImpl)
  if (expected && (context.teamId !== expected.funding.team_id || context.memberId !== expected.funding.member_id
    || context.memberIdentityId !== expected.memberIdentityId || taskId !== expected.funding.task_id)) throw new TeamFundingError('team_identity_required')
  if (context.stopReason) throw new TeamFundingError('credits_exhausted', context.stopReason)
  return context
}
