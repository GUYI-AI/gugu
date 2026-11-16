import { VaultError } from './contracts'
const reasons = {
  REQUEST_PENDING: '请先处理上一张保存卡，再保存下一条。',
  REQUEST_ENDED: '这张保存卡已结束，请重新发起。',
  CARD_DELIVERY_FAILED: '保存卡没有送达，请稍后重试。',
  CREDENTIAL_CHANGED: '这条密码已变更，请重新选择后保存。',
} as const
export class PasswordSaveError extends Error {
  constructor(readonly code: keyof typeof reasons, readonly requestId?: string) { super(code) }
}
/** Only fixed product reasons leave the host. Native exception messages may contain supplied values. */
export function passwordSaveFailure(error: unknown) {
  if (error instanceof PasswordSaveError) return { status: 'unavailable', retry: false, code: error.code,
    error: reasons[error.code], ...(error.requestId ? { requestId: error.requestId } : {}) }
  const reason = error instanceof VaultError ? ({ SYSTEM_STORAGE_UNAVAILABLE: '这台电脑的系统密码存储不可用，请稍后重试。', INVALID_INPUT: '请检查网址和要保存的字段。', CANNOT_UNLOCK: '没有通过本人验证，请解锁密码本后重试。',
    STALE_REFERENCE: '这条密码刚被改过，请重新选择后保存。', STORAGE_FAILED: '密码本未能写入，请稍后重试。', AUDIT_FAILED: '保存记录未能写入，请稍后重试。',
    DATA_MISSING: '密码本数据缺失，请先在设置中恢复。', DATA_DAMAGED: '密码本数据无法读取，请先在设置中恢复。' } as Partial<Record<string, string>>)[error.code] : undefined
  return { status: 'unavailable', retry: false, error: reason ?? '当前设备无法保存，请检查密码本是否可用后重试。' }
}
