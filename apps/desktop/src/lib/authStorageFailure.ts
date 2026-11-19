/** Only bridge codes select UI copy; native details must never be rendered. */
export function authStorageRecoveryAction(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  if (code === 'auth_storage_recovery_required') return '请联系支持恢复登录'
  if (code === 'auth_storage_unavailable') return '请重启应用后重试'
  return null
}
