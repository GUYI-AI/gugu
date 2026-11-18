import { APP_SHOW_SESSION_EVENT } from '@/session/shared/extensions/app-runtime-protocol'
import { directoryDevices, directoryRows, liveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'

/** Carry this route's entry, never a global last-opened room. Only account directory sessions can open. */
export function openPhoneSidebarSession(sessionId: string, innerSidebarEntry?: string): boolean {
  const row = directoryRows(directoryDevices(), liveDeviceSessions()).find(row => row.session.conversationId === sessionId)
  if (!row) return false
  window.dispatchEvent(new CustomEvent(APP_SHOW_SESSION_EVENT, { detail: { ...row, innerSidebarEntry } }))
  return true
}
