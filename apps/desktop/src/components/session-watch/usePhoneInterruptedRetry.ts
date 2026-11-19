import { useMemo, useState } from 'react'
import type { ChatCommands } from '@gugu/session-chat-ui'
import { invokePhoneHost } from '../../mobile/local-agent/phoneHostRpc'
import { runNativeInputAction } from '@/lib/nativeInputFailureNotice'
import { messageForUser } from '@/lib/userFacingError'
import { translateSessionMessage } from '@renderer/localization/locale-store'

/** There is no effect that dispatches execution: only the person's Retry tap
 * enters the existing owner-UI transport. Native admission deduplicates taps. */
export function usePhoneInterruptedRetry(enabled: boolean, deviceId: string, sessionId: string): Pick<ChatCommands, 'onRetryPhoneTask' | 'canRetryPhoneTask'> {
  const scope = JSON.stringify([deviceId, sessionId])
  const [acknowledged, setAcknowledged] = useState<{ scope: string; jobs: ReadonlySet<string> } | null>(null)
  return useMemo(() => enabled ? {
    canRetryPhoneTask: jobId => acknowledged?.scope !== scope || !acknowledged.jobs.has(jobId),
    onRetryPhoneTask: async ({ jobId }) => {
      const accepted = await runNativeInputAction(sessionId, jobId, deviceId, async () => {
        const reply = await invokePhoneHost<{ accepted?: boolean }>(deviceId, 'sessionTimeline.sessionRetry', [{ conversationId: sessionId, jobId }])
        if (!reply.accepted) throw new Error(translateSessionMessage('transcript.retryPhoneTaskFailed'))
      }, (error, attempt) => {
        attempt.failed({ title: translateSessionMessage('transcript.retryPhoneTaskFailed'), description: messageForUser(error), variant: 'destructive' })
      })
      if (accepted) setAcknowledged(previous => ({ scope, jobs: new Set([...(previous?.scope === scope ? previous.jobs : []), jobId]) }))
      return accepted
    },
  } : {}, [enabled, deviceId, sessionId, scope, acknowledged])
}
