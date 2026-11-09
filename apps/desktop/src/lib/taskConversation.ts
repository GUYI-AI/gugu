import { useCallback, useSyncExternalStore } from 'react'
import { directoryDevices, directoryRows, listedSession, liveDeviceSessions, subscribeDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/**
 * The conversation a session's tab is in (`AppWhere.conversation`): the person's private chat with that session's agent, as
 * the session's own row says it (`SessionpageSessionSummary.chatId`, from the roster of the machine it is on) — the chat an
 * App there is in (`getContext().chat`), on the desktop and the phone alike. Null for a session whose agent has no identity
 * yet (its private chat is made when it is provisioned).
 */
export function useTaskConversation(sessionId: string | null | undefined, deviceId?: string | null): string | null {
  // Subscribed to the one value it is (a chat id), as useTaskProjectChat below: a device heartbeat re-renders nothing here.
  const read = useCallback(() => taskConversation(sessionId, deviceId), [sessionId, deviceId])
  return useSyncExternalStore(subscribeDeviceSessions, read)
}

/** The same row useConversationSessionSummary finds: the directory's rows, then each device's live sessions. */
function taskConversation(sessionId: string | null | undefined, deviceId?: string | null): string | null {
  if (!sessionId) return null
  const live = liveDeviceSessions()
  const current = Object.entries(live).flatMap(([id, value]) => value.sessions.map((session) => ({ deviceId: id, session })))
  return [...directoryRows(directoryDevices(), live), ...current]
    .find((row) => row.session.conversationId === sessionId && (!deviceId || row.deviceId === deviceId))?.session.chatId ?? null
}

/**
 * The task's project group, for Files' chat root. Other Apps keep the task's private conversation. Subscribed to the one
 * value it is (a chat id): device heartbeats and session-list changes that leave it as it was re-render nothing.
 */
export function useTaskProjectChat(sessionId: string | null | undefined, deviceId?: string | null): string | null {
  const read = useCallback(() => taskProjectChat(sessionId, deviceId), [sessionId, deviceId])
  return useSyncExternalStore(subscribeDeviceSessions, read)
}

function taskProjectChat(sessionId: string | null | undefined, deviceId?: string | null): string | null {
  if (!sessionId) return null
  const devices = directoryDevices()
  const listed = listedSession(deviceId ? devices.filter((device) => device.device_id === deviceId) : devices, liveDeviceSessions(), sessionId)
  if (!('row' in listed)) return null
  const { row } = listed
  return devices.find((device) => device.device_id === row.deviceId)?.projects
    ?.find((project) => project.localProjectId === row.session.projectId)?.chatId ?? null
}
