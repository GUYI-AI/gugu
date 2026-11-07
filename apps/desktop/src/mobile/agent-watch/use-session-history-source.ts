import type { AgentWatchTimeline } from './agent-watch-store'
import { boundedWindowReady } from './desktop-window-history'
import { useNativeSessionRecord } from './useNativeSessionRecord'

/** History selection is independent of the native input and queue transports. */
export function useSessionHistorySource(input: {
  deviceId: string; sessionId: string; boundedHistory: boolean; native: boolean
  online: boolean; local: boolean; timeline: AgentWatchTimeline
}) {
  const nativeHistory = input.native && !input.boundedHistory
  const nativeRecord = useNativeSessionRecord(input.deviceId, input.sessionId, nativeHistory, input.online, input.local)
  const conversation = nativeHistory ? { ...input.timeline,
    turns: [...(nativeRecord.record?.turns ?? []), ...(nativeRecord.record?.activeTurn ? [nativeRecord.record.activeTurn] : [])],
    hasOlder: nativeRecord.record ? nativeRecord.record.nextCursor !== null : false,
  } : input.timeline
  return { nativeHistory, nativeRecord, conversation, windowReady: boundedWindowReady(input.timeline) }
}
