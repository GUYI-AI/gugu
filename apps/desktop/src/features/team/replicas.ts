import { replica } from '@/lib/replica'
import { TeamCheckoutError, type TeamTopupOrder } from '../../../shared/team-topup'
import { TEAM_REALTIME_CONTEXT_CHANGED } from '../../../shared/team-realtime'
import { TeamApiError } from './errors'
import { teamApi } from './runtime'
import type { CurrentTeamContext, TeamMemberState, TeamProfile } from './types'

/** Every team read: a change the team makes (a member, a cap, a top-up) reads them all again (`refreshTag(TEAM)`). */
export const TEAM = 'team'

/** The signed-in team member's context and profile, checked against each other; read again on its change signal. */
export const teamSession = replica({
  name: 'teamSession',
  scope: 'account',
  tags: [TEAM],
  read: async (owner): Promise<{ context: CurrentTeamContext; profile: TeamProfile }> => {
    const context = await teamApi.context()
    if (context.kind !== 'team') throw new TeamApiError('team_identity_required')
    if (context.member_state !== 'active') throw new TeamApiError('membership_disabled')
    const profile = await teamApi.profile()
    if (context.member_identity_id !== owner || profile.team.id !== context.team_id || profile.membership.id !== context.member_id
      || profile.membership.identity_id !== context.member_identity_id
      || profile.membership.state !== 'active' || profile.membership.role !== context.role
      || profile.membership.revision !== context.membership_revision) throw new TeamApiError('version_conflict')
    return { context, profile }
  },
  refreshOnFocus: true,
  refreshEvery: 30_000,
  watch: { start: () => {
    const refresh = () => { void teamSession.refresh() }
    window.addEventListener(TEAM_REALTIME_CONTEXT_CHANGED, refresh)
    return () => window.removeEventListener(TEAM_REALTIME_CONTEXT_CHANGED, refresh)
  } },
})

/** One page of the team directory with its usage (the settings page), for a search; page by cursor (null = the first). */
export const teamDirectoryPage = replica({
  name: 'teamDirectoryPage',
  scope: 'account',
  tags: [TEAM],
  read: async (_owner, teamId: string, _revision: number, _role: string, search: string, cursor: string | null) => {
    const page = await teamApi.directorySummary({ query: search || undefined, cursor: cursor ?? undefined, limit: 50 })
    if (page.team_id !== teamId) throw new TeamApiError('team_identity_required')
    return page
  },
  refreshEvery: 30_000,
})

/** One page of the team's members in one state; page by cursor (null = the first). */
export const teamMembersPage = replica({
  name: 'teamMembersPage',
  scope: 'account',
  tags: [TEAM],
  read: (_owner, _teamId: string, state: Exclude<TeamMemberState, 'provisioning'>, cursor: string | null) =>
    teamApi.members({ state, cursor: cursor ?? undefined, limit: 50 }),
})

/** One page of the member's own usage this period; page by cursor (null = the first). */
export const teamUsagePage = replica({
  name: 'teamUsagePage',
  scope: 'account',
  tags: [TEAM],
  read: (_owner, _teamId: string, _scope: string, cursor: string | null) =>
    teamApi.myUsage({ cursor: cursor ?? undefined, limit: 50 }),
})

/** The price of a top-up of this many credits (with a coupon). */
export const teamTopupQuote = replica({
  name: 'teamTopupQuote',
  scope: 'account',
  tags: [TEAM],
  read: (_owner, teamId: string, _revision: number, credits: number, couponCode: string) =>
    teamApi.topupQuote({ teamId, credits, couponCode: couponCode || undefined }),
})

/** A top-up order this window started, checked against what it was started for; read every 3 s until it is settled. */
export const teamTopupOrder = replica({
  name: 'teamTopupOrder',
  scope: 'account',
  tags: [TEAM],
  read: async (_owner, teamId: string, orderId: string, amountCny: string, credits: number): Promise<TeamTopupOrder> => {
    const value = await teamApi.topupOrder(teamId, orderId)
    if (value.id !== orderId || value.amountCny !== amountCny || value.credits !== credits) throw new TeamCheckoutError('invalid_response')
    return value
  },
  refreshEvery: (value) => (value?.status && value.status !== 'pending' ? false : 3000),
})
