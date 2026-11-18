import { supportsSourceWindow } from '@gugu/session-core/session-record/window-cache/formats'
import { useNativeSessionRecord } from './useNativeSessionRecord'

/**
 * Source-format routing is explicit and happens before any read, never on failure.
 *
 * `cleanedRecord`: the page reads what the session page's left column reads — the task page archive (a native-input
 * session) or the ordinary timeline — and never the bounded source window, whose screen is the provider's raw records
 * (delivery envelopes, system reminders, the task context, thinking) until their canonical owners resolve. The
 * assistant/App task layer and App peeks ask for it (D12); every other page keeps the format routing.
 */
export function useSessionHistorySource(input: {
  deviceId: string; sessionId: string; mobile: boolean; phoneHost: boolean; sourceFormat: string; native: boolean
  online: boolean; local: boolean; cleanedRecord?: boolean
}) {
  const boundedHistory = !input.cleanedRecord && !input.mobile && !input.phoneHost && supportsSourceWindow(input.sourceFormat)
  const nativeHistory = input.native && !boundedHistory
  const nativeRecord = useNativeSessionRecord(input.deviceId, input.sessionId, nativeHistory, input.online, input.local)
  return { boundedHistory, nativeHistory, nativeRecord }
}
