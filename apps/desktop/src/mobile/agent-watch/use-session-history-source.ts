import { supportsSourceWindow } from '@gugu/session-core/session-record/window-cache/formats'
import { useNativeSessionRecord } from './useNativeSessionRecord'

/** Source-format routing is explicit and happens before any read, never on failure. */
export function useSessionHistorySource(input: {
  deviceId: string; sessionId: string; mobile: boolean; phoneHost: boolean; sourceFormat: string; native: boolean
  online: boolean; local: boolean
}) {
  const boundedHistory = !input.mobile && !input.phoneHost && supportsSourceWindow(input.sourceFormat)
  const nativeHistory = input.native && !boundedHistory
  const nativeRecord = useNativeSessionRecord(input.deviceId, input.sessionId, nativeHistory, input.online, input.local)
  return { boundedHistory, nativeHistory, nativeRecord }
}
