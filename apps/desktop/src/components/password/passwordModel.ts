import { useCallback, useState } from 'react'
import type { PasswordSyncRequest, PasswordSyncView, PasswordUiCommand, PasswordUiReply } from '@gugu/core/shared/passwordBetaProtocol'
import { passwordVault } from '@/lib/passwordBetaNotifications'
import { i18n } from '@/i18n'
import '@/i18n/registerSettingsCatalog'

const ERROR_KEYS: Readonly<Record<string, string>> = {
  SYSTEM_STORAGE_UNAVAILABLE: 'systemStorage', CANNOT_UNLOCK: 'cannotUnlock', INVALID_INPUT: 'invalidInput',
  STALE_REFERENCE: 'stale', RECOVERY_INVALID: 'recoveryInvalid',
}
export const passwordErrorText = (code: string) => i18n.t(`passwords.errors.${ERROR_KEYS[code] ?? 'generic'}`, { ns: 'settings' })

/** Which device requests this device should put in front of the person: not those opened on another device. */
export const promptedRequests = (sync?: PasswordSyncView): PasswordSyncRequest[] =>
  sync?.state === 'ready' ? sync.requests.filter(request => request.stage !== 'elsewhere') : []
/** This device waits for another one to let it use the passwords. */

type Reply = Extract<PasswordUiReply, { ok: true }>
/** One vault command with its busy flag and error line; the reply's snapshot reaches every surface. */
export function usePasswordCommand() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = useCallback(async (command: PasswordUiCommand): Promise<Reply | undefined> => {
    setBusy(true)
    try {
      // Bound before the vault answers: a reply that lands after the account changed is not put into the next one.
      const vault = passwordVault.at()
      const reply = await window.passwordVaultBeta?.invoke(command)
      if (!reply?.ok) { setError(passwordErrorText(reply?.code ?? '')); return undefined }
      vault.set(reply.snapshot); setError('')
      return reply
    } catch { setError(passwordErrorText('')); return undefined }
    finally { setBusy(false) }
  }, [])
  const clear = useCallback(() => setError(''), [])
  return { busy, error, run, clear }
}
