import { useNativeSessionRecord } from './useNativeSessionRecord'

/** A native-input session's page reads its native record (the task page archive); every other one reads the ordinary timeline. */
export function useSessionHistorySource(input: { deviceId: string; sessionId: string; native: boolean; online: boolean; local: boolean }) {
  const nativeHistory = input.native
  const nativeRecord = useNativeSessionRecord(input.deviceId, input.sessionId, nativeHistory, input.online, input.local)
  return { nativeHistory, nativeRecord }
}
