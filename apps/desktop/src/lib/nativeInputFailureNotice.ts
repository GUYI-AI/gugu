import { state } from './outbox/kinds/sessionInput'
import { messageFailureNotice, type MessageFailureAttempt } from './messageFailureNotice'
import { messageForUser } from './userFacingError'
import { translateSessionMessage } from '@renderer/localization/locale-store'

export function nativeInputFailureNotice(accountId: string | null, sessionId: string, id: string, deviceId: string | null) {
  return messageFailureNotice(['acp', JSON.stringify([accountId, deviceId]), sessionId, id])
}

/** Sender and host views name the same native input; neither its text nor its current projection owns the notice. */
export async function runNativeInputAction(sessionId: string, id: string, deviceId: string | null,
  action: () => Promise<unknown>, report = (error: unknown, attempt: MessageFailureAttempt) => {
    attempt.failed({ title: translateSessionMessage('acpFailure.sendMessage'), description: messageForUser(error), variant: 'destructive' })
  }): Promise<boolean> {
  const attempt = nativeInputFailureNotice(state().accountId, sessionId, id, deviceId).begin()
  try { await action(); attempt.succeeded(); return true }
  catch (error) { report(error, attempt); return false }
}
