export type AuthStorageRecoveryAction = 'retry' | 'relogin' | 'closure-pending'

/** Only bridge codes select UI copy; native details must never be rendered. */
export function authStorageRecoveryAction(error: unknown): AuthStorageRecoveryAction | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  if (code === 'auth_storage_recovery_required') return 'relogin'
  if (code === 'auth_storage_unavailable') return 'retry'
  if (code === 'auth_storage_closure_pending') return 'closure-pending'
  return null
}
export const authStorageRecoveryCopy = (action: AuthStorageRecoveryAction) =>
  action === 'relogin' ? 'shell.authStorage.unreadable' : action === 'closure-pending' ? 'shell.authStorage.closurePending' : 'shell.authStorage.unavailable'
