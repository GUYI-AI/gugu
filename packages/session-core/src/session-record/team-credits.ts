export type TeamCreditStopReason = 'team_member_monthly_cap_reached' | 'team_credits_exhausted';

export function teamCreditStopReason(value: unknown): TeamCreditStopReason | null {
  return value === 'team_member_monthly_cap_reached' || value === 'team_credits_exhausted' ? value : null;
}

/** Only typed gateway/control-plane fields select team copy. Never match a message or a balance. */
export function teamCreditReason(value: unknown): TeamCreditStopReason | null {
  if (typeof value === 'string') {
    const start = value.indexOf('{'), end = value.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return teamCreditReason(JSON.parse(value.slice(start, end + 1))); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const error = row.error && typeof row.error === 'object' ? row.error as Record<string, unknown> : row;
  return error.code === 'credits_exhausted' ? teamCreditStopReason(error.reason_code) : null;
}
