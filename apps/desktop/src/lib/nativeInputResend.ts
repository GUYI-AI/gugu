import type { NativeInputRetryOptions, NativeInputRetryResult } from '@/session/shared/core/sessions/session-life'
import { showModal } from '@renderer/lib/modal/modal-provider'
import { translateSessionMessage as t } from '@renderer/localization/locale-store'
import { runNativeInputAction } from './nativeInputFailureNotice'
import { rendererLogger } from './log'
import { reaction } from 'mobx'
import { modalStore } from '@renderer/lib/modal/modal-store'

type Check = Extract<NativeInputRetryResult, { kind: 'confirmation-required' }>
type Retry = (options: NativeInputRetryOptions) => Promise<NativeInputRetryResult | void>
const active = new Map<string, Promise<boolean>>()
const log = rendererLogger('session/native-resend')

/** Host diagnostics select fixed copy; neither raw codes nor details belong in the dialog. */
function reasonText(code: string): string {
  const copies: Record<string, string> = {
    native_tail_does_not_cover_history: 'tail',
    native_record_boundary_missing: 'record', native_record_incomplete: 'record', native_record_invalid: 'record',
    native_source_changed: 'changed', native_session_changed: 'changed', native_read_budget_exhausted: 'budget',
    native_source_unreadable: 'unreadable', native_lookup_failed: 'unreadable',
    native_session_unavailable: 'unavailable', native_location_unavailable: 'unavailable', native_format_not_supported: 'unavailable',
    native_session_identity_unavailable: 'identity', native_input_identity_unavailable: 'identity',
  }
  const key = Object.hasOwn(copies, code) ? copies[code] : 'unknown'
  return t(`nativeResend.reason.${key}`)
}

function actionText(error: unknown): string {
  const copies: Record<string, string> = {
    'The resend confirmation expired; check this message again': 'expired',
    'The message changed after resend confirmation': 'expired',
    'This account cannot resend this input': 'account',
    'This session cannot resend an input now': 'changed',
    'The session changed while checking delivery': 'changed',
    'Native delivery cannot be checked: native_session_changed': 'changed',
    native_session_changed: 'changed',
  }
  const code = String((error as Error)?.message ?? error)
  const key = Object.hasOwn(copies, code) ? copies[code] : 'failed'
  return t(`nativeResend.action.${key}`)
}

function confirm(result: Check): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false, dispose = () => {}
    const finish = (confirmed: boolean) => {
      if (settled) return
      settled = true; dispose(); resolve(confirmed)
    }
    showModal('confirmActionModal', {
      title: t('nativeResend.title'), description: `${reasonText(result.reason)}\n\n${t('nativeResend.description')}`,
      confirmLabel: t('nativeResend.confirm'), variant: 'default',
      onSuccess: () => finish(true), onClose: () => finish(false),
    })
    if (settled) return
    const request = modalStore.request
    // Replaced/externally closed dialogs must not keep this message's click pending forever.
    // A successful modal closes before its onSuccess; let that callback win this turn.
    dispose = reaction(() => [modalStore.request, modalStore.activeModalId], () => queueMicrotask(() => {
      if (modalStore.request !== request || modalStore.activeModalId !== 'confirmActionModal') finish(false)
    }))
  })
}

/** Both native-message views use the same explicit click/confirmation path, never automatic recovery. */
export function resendNativeInputByPerson(sessionId: string, messageId: string, deviceId: string | null, retry: Retry): Promise<boolean> {
  const key = JSON.stringify([deviceId, sessionId, messageId])
  const pending = active.get(key)
  if (pending) return pending
  const diagnose = (result: Check) => log.warn({ sessionId, messageId, deviceId, reason: result.reason, detail: result.detail }, 'Native delivery evidence is incomplete')
  const operation = runNativeInputAction(sessionId, messageId, deviceId, async () => {
    const result = await retry({ allowConfirmation: true })
    if (!result || result.kind === 'done') return
    diagnose(result)
    if (!await confirm(result)) return
    const checked = await retry({ allowConfirmation: true, confirmation: result.confirmation })
    if (checked?.kind === 'confirmation-required') { diagnose(checked); throw new Error('Native resend still requires confirmation') }
  }, (error, attempt) => {
    log.error({ sessionId, messageId, deviceId, error: String(error) }, 'Native resend action failed')
    attempt.failed({ title: t('acpFailure.sendMessage'), description: actionText(error), variant: 'destructive' })
  })
    .finally(() => { if (active.get(key) === operation) active.delete(key) })
  active.set(key, operation)
  return operation
}
