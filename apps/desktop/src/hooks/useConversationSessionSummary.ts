import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { directoryRows, useDirectoryDevices, useDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/**
 * What `pick` reads of a task's summary (before its live subscription is ready the account's device digest identifies it).
 * Only a change of what was picked re-renders: the summary itself changes with every streamed chunk of a running turn.
 */
export function useConversationSessionSummary<T>(sessionId: string | undefined, deviceId: string | null | undefined, pick: (summary: SessionpageSessionSummary | undefined) => T): T {
  const devices = useDirectoryDevices()
  return useDeviceSessions((live) => {
    const current = Object.entries(live).flatMap(([id, value]) => value.sessions.map(session => ({ deviceId: id, session })))
    return pick([...directoryRows(devices, live), ...current]
      .find(row => row.session.conversationId === sessionId && (!deviceId || row.deviceId === deviceId))?.session)
  })
}
