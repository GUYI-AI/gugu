import type { TeamChoice, TeamStopReason } from './types'

/** Server diagnostics and credential-bearing payloads never become user copy. */
export class TeamApiError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly reason_code?: TeamStopReason,
    readonly retry_after_seconds?: number,
    readonly teams?: TeamChoice[],
  ) {
    super('Team request failed')
    this.name = 'TeamApiError'
  }
}

export class TeamResponseError extends Error {
  constructor(readonly field: string) {
    super('Invalid team response')
    this.name = 'TeamResponseError'
  }
}

const STOP_REASONS = new Set<TeamStopReason>(['team_member_monthly_cap_reached', 'team_credits_exhausted'])
export function teamStopReason(value: unknown): TeamStopReason | null {
  return typeof value === 'string' && STOP_REASONS.has(value as TeamStopReason) ? value as TeamStopReason : null
}

/** Only structured reason codes select a funding notice, never HTTP/message/余额 heuristics. */
export function teamFailureReason(error: unknown): TeamStopReason | null {
  const seen = new Set<object>(), pending = [error]
  while (pending.length) {
    const item = pending.shift()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    const value = item as Record<string, unknown>
    const reason = teamStopReason(value.reason_code) ?? teamStopReason(value.stop_reason)
    if (reason) return reason
    pending.push(value.error, value.cause)
  }
  return null
}

export function isTeamAccessRefusal(error: unknown): boolean {
  return error instanceof TeamApiError && ['membership_disabled', 'team_identity_required', 'region_mismatch', 'unauthenticated'].includes(error.code)
}
