import type { TeamAccountKind } from './types'

/** Trusted Auth app_metadata is a compatibility hint, never a role or membership authority. */
export function accountKindFromMetadata(metadata: Record<string, unknown> | undefined): TeamAccountKind {
  const kind = metadata?.gugu_account_kind
  if (kind === undefined || kind === null || kind === 'personal') return 'personal'
  if (kind === 'team_member' || kind === 'team_login_anchor') return kind
  return 'unknown'
}

export function hasTeamAccountMarker(user: { accountKind?: TeamAccountKind } | null | undefined): boolean {
  return user?.accountKind !== undefined && user.accountKind !== 'personal'
}
