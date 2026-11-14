import type { TFunction } from 'i18next'
import { TeamApiError, TeamResponseError } from './errors'
import type { TeamRole, TeamStopReason } from './types'
import './catalog'

export function teamRoleLabel(role: TeamRole, t: TFunction<'team'>): string {
  return t(role === 'superadmin' ? 'roleSuper' : role === 'admin' ? 'roleAdmin' : 'roleMember')
}

export function teamFailureCopy(reason: TeamStopReason, t: TFunction<'team'>): string {
  return t(reason === 'team_credits_exhausted' ? 'poolStop' : 'capStop')
}

export function teamErrorCopy(error: unknown, t: TFunction<'team'>): string {
  if (error instanceof TeamResponseError) return t('invalidResponse')
  if (!(error instanceof TeamApiError)) return t('updateFailed')
  if (error.reason_code) return teamFailureCopy(error.reason_code, t)
  const keys: Record<string, string> = {
    membership_disabled: 'memberDisabled', team_identity_required: 'signInRequired', unauthenticated: 'signInRequired',
    region_mismatch: 'regionMismatch', forbidden: 'forbidden', invalid_code: 'invalidCode',
    verification_expired: 'expiredVerification', verification_required: 'expiredVerification', rate_limited: 'rateLimited',
    version_conflict: 'conflict', idempotency_conflict: 'duplicate', not_found: 'notFound', invalid_response: 'invalidResponse',
    dependency_unavailable: 'unavailable', billing_unavailable: 'unavailable', gateway_unavailable: 'unavailable',
    revocation_pending: 'revokeCheckFailed',
    invitation_invalid: 'invitationInvalid', invitation_used: 'invitationInvalid', google_failed: 'googleFailed', google_unavailable: 'googleFailed', google_cancelled: 'googleFailed',
  }
  return t(keys[error.code] ?? 'updateFailed')
}
