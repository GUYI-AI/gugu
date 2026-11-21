import { useEffect, useMemo, useRef } from 'react'
import { sessionLifeViewChannel } from '@/session/shared/core/sessions/sessionEvents'
import { onMachineEvent as onLocalMachineEvent } from '@renderer/lib/ipc'
import { lifeReadable, readLifeVia, watchLife, type LifeRoute } from '@renderer/features/sessions/stores/session-life-views'
import { useSelect } from '@/lib/selectStore'
import { messageForUser } from '@/lib/userFacingError'
import { machineRpc, onLinkChange, onMachineEvent } from './sessionpage-rpc'

/** The phone's route to a session's machine: the device RPC (this computer's runtime when `local`), its link epochs. */
export function phoneLifeRoute(deviceId: string, local: boolean): LifeRoute {
  return local
    ? { key: '', read: (sessionId) => machineRpc(deviceId, true).sessions.lifeView(sessionId), listen: (deliver) => onLocalMachineEvent(null, sessionLifeViewChannel, deliver) }
    : {
        key: deviceId,
        read: (sessionId) => machineRpc(deviceId, false).sessions.lifeView(sessionId),
        listen: (deliver) => onMachineEvent(deviceId, sessionLifeViewChannel, deliver),
        onLink: (change) => onLinkChange(deviceId, change),
      }
}

/** Same host lifecycle as the desktop (session-life-views); a link that comes back is a new epoch, read when the page wants. */
export function useSessionLifeView(deviceId: string, sessionId: string, local: boolean, enabled: boolean, readInitial = true) {
  const route = useMemo(() => phoneLifeRoute(deviceId, local), [deviceId, local])
  const readable = useMemo(() => lifeReadable(route, sessionId), [route, sessionId])
  const life = useSelect(readable, (value) => value)
  const wantsRead = useRef(readInitial)
  wantsRead.current = readInitial
  useEffect(() => (enabled ? watchLife(route, sessionId, () => wantsRead.current) : undefined), [route, sessionId, enabled])
  // Read once per opening when the page wants it (a normal open waits for the host's push).
  const asked = useRef<string | null>(null)
  const key = `${route.key}/${sessionId}`
  useEffect(() => {
    if (!enabled || !readInitial || asked.current === key) return
    asked.current = key
    void readLifeVia(route, sessionId).catch(() => undefined)
  }, [enabled, readInitial, key, route, sessionId])
  useEffect(() => { if (!enabled) asked.current = null }, [enabled])
  const current = () => (enabled ? readable.get().view : null)
  return { view: enabled ? life.view : null, error: enabled && life.error ? messageForUser(new Error(life.error)) : null, current }
}
