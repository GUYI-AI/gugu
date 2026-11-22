import { state, changed, EMPTY, publishRows, sessionInputKind, sessionInputSteeringAvailable, setSessionInputEnqueueCheck, SESSION_INPUT } from '@/lib/outbox/kinds/sessionInput'
import { SessionInputAdmissionError, sessionInputAdmission } from '@gugu/core/shared/sessionInputAdmission'
import { NativeConversationReadHost } from '@/components/chat/NativeConversationReadHost'
import { ChatSummariesHost } from '@/components/chat/ChatSummariesHost'
import { useLocalSessionDirectory } from './useLocalSessionDirectory'
import { useEffect, useRef } from 'react'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { TASK_ATTACHMENT_PROTOCOL } from '@gugu/session-core/session-record/contract'
import { useDevicesStore } from '@/store/devicesContext'
import { getRendererSession } from '@/lib/sessionPublication'
import { platform } from '@/platform'
import { SessionInputFailureError, withoutQueuedAttachments, type SessionInput } from '@/lib/sessionInput'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { rendererLogger } from '@/lib/log'
import { liveDeviceSessions, subscribeDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { watchSessionSendQueues } from '@/lib/sessionSendQueueHost'
import { watchPhoneSessionSendQueues } from '@/components/session-watch/phone-send-queue-host'
import { ensureKind, outbox } from '@/lib/outbox'
import { readOutboxKind } from '@/lib/outbox/kinds/read'
import { assistantNoticeOutboxKind } from '@/lib/outbox/kinds/assistantNotice'
import { importLegacyWrites } from '@/lib/outbox/legacy'

/**
 * Runs with the signed-in shell, including while the conversation itself is closed: the account's outbox kinds that
 * need no chat store (session inputs, read positions, App change notices), and the rows the session pages read.
 */
export function OutboxHost({ accountId }: { accountId: string }) {
  const { devices, phones } = useDevicesStore()
  useLocalSessionDirectory(accountId, devices.find(device => device.is_current_device)?.device_id)
  const hosts = useRef([...devices, ...(phones ?? [])])
  hosts.current = [...devices, ...(phones ?? [])]
  useEffect(() => {
    let active = true
    const own = state()
    own.accountId = accountId
    own.rows = EMPTY
    own.valid = () => active && own.accountId === accountId && getRendererSession()?.user.id === accountId
    const oldAttachmentHost = (input: Pick<SessionInput, 'deviceId' | 'sessionId' | 'files'>) => {
      if (!input.files?.length || !input.deviceId) return false
      const device = hosts.current.find(row => row.device_id === input.deviceId)
      if (!device?.is_online || device.is_current_device) return false
      const version = device.capabilities.remote_protocol
      if (isPhoneDevice(device)) return typeof version !== 'number' || version < TASK_ATTACHMENT_PROTOCOL
      const native = liveDeviceSessions()[input.deviceId]?.sessions.find(row => row.conversationId === input.sessionId)?.nativeInputVersion
      return native === 1
    }
    const box = outbox()
    // Static kinds stay registered: what a previous run queued drains from the start.
    ensureKind(box, readOutboxKind)
    ensureKind(box, assistantNoticeOutboxKind)
    const stops = [
      box.register(sessionInputKind({
        // A queued file sent to an old host keeps its caption and explains what was omitted.
        prepare: async input => oldAttachmentHost(input) ? withoutQueuedAttachments(input, input.files!.length) : input,
        send: async input => {
          if (input.steerIfBusy && !sessionInputSteeringAvailable(input.sessionId)) throw new SessionInputFailureError({ code: 'host-not-ready' })
          const device = hosts.current.find(device => device.device_id === input.deviceId)
          // This computer is named either way (no device id, or its own id); either way its own host answers over IPC.
          const remoteId = !input.deviceId || device?.is_current_device ? null : input.deviceId
          if (remoteId && device && !device.is_online) throw new SessionInputFailureError({ code: 'host-offline' })
          if (remoteId && !(device && isPhoneDevice(device))) {
            const summary = liveDeviceSessions()[remoteId]?.sessions.find(session => session.conversationId === input.sessionId)
            if (summary?.nativeInputVersion !== 1 && summary?.nativeInputVersion !== 2) throw new SessionInputFailureError({ code: 'host-not-ready' })
          }
          const request = { conversationId: input.sessionId, text: input.text, ...(input.steerIfBusy ? { steerIfBusy: true as const } : {}), ...(input.files?.length ? { files: input.files } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}) }
          if (device && isPhoneDevice(device)) {
            const { invokePhoneHost } = await import('@/mobile/local-agent/phoneHostRpc')
            const result = await invokePhoneHost<{ accepted?: boolean }>(device.device_id, 'sessionTimeline.sessionSend', [{ ...request, clientRequestId: input.id }])
            if (!result.accepted) throw new SessionInputFailureError({ code: 'phone-unconfirmed' })
          } else if (platform.kind === 'electron') {
            const { rpcOn } = await import('@/session/renderer/lib/ipc')
            const result = await rpcOn(remoteId).sessionTimeline.sessionSend({ ...request, clientMessageId: input.id })
            if (!result.ok) throw new SessionInputAdmissionError(result.error.message, sessionInputAdmission(result.error), result.error.code)
            if (result.value.clientMessageId !== input.id) throw new Error('Session host acknowledged another input')
          } else {
            const { sendSessionText } = await import('@/components/session-watch/sessionpage-rpc')
            if (!input.deviceId) throw new Error('Remote session input has no device')
            await sendSessionText(input.deviceId, input.sessionId, input.text, input.id, input.files, input.attachments, input.steerIfBusy)
          }
        },
      })),
      setSessionInputEnqueueCheck(input => {
        if (oldAttachmentHost(input)) throw new Error(translateSessionMessage('composer.attachmentHostUpdateRequired'))
      }),
      box.subscribe(publishRows),
      // A host that came back, or a session that became ready, takes what was waiting for it.
      subscribeDeviceSessions(() => box.kick(SESSION_INPUT)),
    ]
    void importLegacyWrites(accountId).then(publishRows, error =>
      rendererLogger('session/input-outbox').error({ error: String(error) }, 'Writes queued by the previous build could not be moved'))
    publishRows()
    return () => {
      active = false
      for (const stop of stops) stop()
      if (own.accountId === accountId) { own.accountId = null; own.rows = EMPTY; changed() }
    }
  }, [accountId])
  useEffect(() => {
    if (platform.kind !== 'electron') return watchPhoneSessionSendQueues(accountId)
    const stopNative = watchSessionSendQueues(accountId, () => hosts.current.find(device => device.is_current_device)?.device_id,
      input => { const device = hosts.current.find(device => device.device_id === input.deviceId); return !device || !isPhoneDevice(device) })
    const stopPhone = watchPhoneSessionSendQueues(accountId, { phoneHostsOnly: true })
    return () => { stopNative(); stopPhone() }
  }, [accountId])
  useEffect(() => { outbox().kick(SESSION_INPUT) }, [devices, phones])
  return <><ChatSummariesHost /><NativeConversationReadHost /></>
}
