import type { ReactNode } from 'react'
import { useDevicesStore } from '../../store/devicesContext'
import { listedSession, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { SessionTimelinePage } from './SessionTimelinePage'

/**
 * G1 on the phone: a session beside an App (`showSession(id, { peek: true })`) is its timeline over the App's frame — the
 * page the task tab opens for its row, found the way that row is (`listedSession`), its back the peek's.
 *
 * `deviceId`: the machine the caller already opened this session on. Only that machine's row is read then — two rows of
 * one computer (a new data directory is a new row, the old one stays) can list the same session id, and which of them
 * comes first changes as they go on and offline, so the header would jump to the other row's state and last-seen time.
 *
 * `cleanedRecord`: the page reads what the left column reads, never the bounded source window (SessionTimelinePage).
 * `appPanel`: drawn over an App's panel (SessionTimelinePage).
 */
export function PeekSessionTimeline({ sessionId, deviceId, local, nativeOnly = false, cleanedRecord = false, appPanel = false, fallback = null, onBack }: {
  sessionId: string; deviceId?: string; local?: boolean; nativeOnly?: boolean; cleanedRecord?: boolean; appPanel?: boolean; fallback?: ReactNode; onBack: () => void
}) {
  const { devices } = useDevicesStore()
  const listed = listedSession(deviceId ? devices.filter((one) => one.device_id === deviceId) : devices, useLiveDeviceSessions(), sessionId)
  const device = 'row' in listed ? devices.find((one) => one.device_id === listed.row.deviceId) : undefined
  if (!('row' in listed) || !device || (nativeOnly && listed.row.session.nativeInputVersion !== 1 && listed.row.session.nativeInputVersion !== 2)) return fallback
  return <SessionTimelinePage key={`${device.device_id}:${sessionId}`} device={device} session={listed.row.session} local={local} cleanedRecord={cleanedRecord} appPanel={appPanel} onBack={onBack} />
}
