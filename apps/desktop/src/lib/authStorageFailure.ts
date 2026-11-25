export type AuthStorageRecoveryAction = 'shell.authStorage.contactSupport' | 'shell.authStorage.restart'

/** Only bridge codes select UI copy; native details must never be rendered. */
export function authStorageRecoveryAction(error: unknown): AuthStorageRecoveryAction | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  if (code === 'auth_storage_recovery_required') return 'shell.authStorage.contactSupport'
  if (code === 'auth_storage_unavailable') return 'shell.authStorage.restart'
  return null
}
