import { useNativeSessionRecord } from './useNativeSessionRecord'

/**
 * Source-format routing is explicit and happens before any read, never on failure.
 *
 * A task page draws the session's cleaned record, as the session page does: the task page archive (a native-input
 * session) or the ordinary timeline. It is never routed to the bounded source window: that window's screen is the
 * provider's raw records — delivery envelopes, system reminders, the task context, the model's thinking — as fragments
 * nothing on the host resolves to canonical turns, so a task page on it showed the agent's raw prompt (D12).
 */
export function useSessionHistorySource(input: {
  deviceId: string; sessionId: string; native: boolean; online: boolean; local: boolean
}) {
  const boundedHistory = false
  const nativeHistory = input.native
  const nativeRecord = useNativeSessionRecord(input.deviceId, input.sessionId, nativeHistory, input.online, input.local)
  return { boundedHistory, nativeHistory, nativeRecord }
}
