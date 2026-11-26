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
