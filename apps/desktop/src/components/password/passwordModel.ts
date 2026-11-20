import { useCallback, useState } from 'react'
import type { PasswordSyncRequest, PasswordSyncView, PasswordUiCommand, PasswordUiReply } from '@gugu/core/shared/passwordBetaProtocol'
import { publishPasswordSnapshot } from '@/lib/passwordBetaNotifications'

export const passwordErrorText = (code: string) => code === 'SYSTEM_STORAGE_UNAVAILABLE' ? '这台电脑的系统密码存储不可用，请稍后重试。' : code === 'CANNOT_UNLOCK' ? '没有通过本人验证。'
  : code === 'INVALID_INPUT' ? '请填写 https 网址、账号和密码；字段名不能重复。'
    : code === 'STALE_REFERENCE' ? '这条密码刚被改过，请返回后重试。'
    : code === 'RECOVERY_INVALID' ? '恢复码不对，请核对后重输。'
    : code === 'VAULT_STILL_OPENABLE' ? '还有设备能打开这些密码：到那台设备上点允许；设备丢了的话，先在「设置 › 设备」里移除它。'
      : '暂时无法完成，请稍后重试。'

/** Which device requests this device should put in front of the person: not those opened on another device. */
export const promptedRequests = (sync?: PasswordSyncView): PasswordSyncRequest[] =>
  sync?.state === 'ready' ? sync.requests.filter(request => request.stage !== 'elsewhere') : []
/** This device waits for another one to let it use the passwords. */
export const waitingToJoin = (sync?: PasswordSyncView) => sync?.state === 'joining' || sync?.state === 'blocked'

type Reply = Extract<PasswordUiReply, { ok: true }>
/** One vault command with its busy flag and error line; the reply's snapshot reaches every surface. */
export function usePasswordCommand() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = useCallback(async (command: PasswordUiCommand): Promise<Reply | undefined> => {
    setBusy(true)
    try {
      const reply = await window.passwordVaultBeta?.invoke(command)
      if (!reply?.ok) { setError(passwordErrorText(reply?.code ?? '')); return undefined }
      publishPasswordSnapshot(reply.snapshot); setError('')
      return reply
    } catch { setError(passwordErrorText('')); return undefined }
    finally { setBusy(false) }
  }, [])
  return { busy, error, run, clear: () => setError('') }
}
