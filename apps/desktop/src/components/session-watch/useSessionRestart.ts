import { useEffect, useMemo, useRef, useState } from 'react'
import type { PendingPrompt } from '@gugu/session-chat-ui'
import { lifeIsStarting, type LifeView } from '@/session/shared/core/sessions/session-life'
import { canStartFreshSession } from '@/session/shared/core/sessions/session-recovery'
import { sessionInputBubbles } from '@/lib/sessionInputOutbox'
import { messageForUser } from '@/lib/userFacingError'
import { machineRpc } from './sessionpage-rpc'
import { replica, useReplica } from '@/lib/replica'
import { useSelect } from '@/lib/selectStore'
import { lifeReadable, readLifeVia, watchLife } from '@renderer/features/sessions/stores/session-life-views'
import { phoneLifeRoute } from './useSessionLifeView'
import { recoverTimelineRead } from './timeline-read-recovery'

/** A session's row on its machine, as far as a restart needs it. */
const restartSessionRow = replica({
  name: 'restartSessionRow',
  scope: 'account',
  read: async (_owner: string, deviceId: string, local: boolean, projectId: string, sessionId: string) => {
    const [row] = await machineRpc(deviceId, local).sessions.getUnarchivedSession(projectId, sessionId)
    return row ? { providerSessionState: row.providerSessionState, firstUtterance: row.firstUtterance } : null
  },
  fresh: 0,
})

type RestartAttempt = { key: string; afterVersion: number }

/** Restart is the desktop's existing host action; only its lifecycle, never a local timer, says Starting. */
export function useSessionRestart({ deviceId, projectId, sessionId, missing, online, local, onReady }: {
  deviceId: string; projectId: string; sessionId: string; missing: boolean; online: boolean; local: boolean
  onReady(): void | Promise<void>
}) {
  const key = `${deviceId}:${sessionId}:${local}`
  const current = useRef(key)
  current.current = key
  const ready = useRef(onReady)
  ready.current = onReady
  const inFlight = useRef<RestartAttempt | null>(null)
  const observed = useRef<RestartAttempt | null>(null)
  const restarted = useRef<RestartAttempt | null>(null)
  const route = useMemo(() => phoneLifeRoute(deviceId, local), [deviceId, local])
  // Whether "start fresh" is offered derives from the session's row and its lifecycle.
  const asking = missing && online
  const rowReading = useReplica(restartSessionRow, asking ? [deviceId, local, projectId, sessionId] : null)
  const lifeNow = useSelect(useMemo(() => lifeReadable(route, sessionId), [route, sessionId]), (value) => value.view)
  useEffect(() => (asking ? watchLife(route, sessionId, () => true) : undefined), [asking, route, sessionId])
  useEffect(() => { if (asking) void readLifeVia(route, sessionId).catch(() => undefined) }, [asking, route, sessionId])
  const sessionRow = rowReading.state === 'value' ? rowReading.value : null
  const absent = sessionRow !== null && lifeNow !== null && (sessionRow.providerSessionState === 'missing' || lifeNow.kind === 'dormant')
  const eligible = asking && absent && lifeNow !== null && !lifeIsStarting(lifeNow) && lifeNow.kind !== 'ready'
    && canStartFreshSession('provider_session_missing', sessionRow?.firstUtterance) ? key : null
  const [attempt, setAttempt] = useState<RestartAttempt | null>(null)
  const [view, setView] = useState<{ key: string; value: LifeView } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)

  // @@@effect-flow(command) - waits for the restart command to settle: its lifecycle (read through the one life mirror) passes the clicked version
  useEffect(() => {
    if (attempt?.key !== key || !online) return
    let active = true
    const recoveryAbort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const next = await recoverTimelineRead(() => readLifeVia(route, sessionId), recoveryAbort.signal)
        if (!active) return
        if (next.version > attempt.afterVersion) {
          observed.current = attempt
          setView({ key, value: next })
          setError(null)
          if (next.kind === 'ready') {
            try { await ready.current() } catch (cause) { if (active) setError({ key, message: messageForUser(cause) }) }
            if (active) setAttempt(null)
            return
          }
          if (next.kind === 'dormant' && next.hold !== null) { setAttempt(null); return }
          // A session whose first turn ran restarts with nothing to run: resting with nothing pending settles it.
          if (next.kind === 'dormant' && !next.pending.count && restarted.current === attempt) {
            try { await ready.current() } catch (cause) { if (active) setError({ key, message: messageForUser(cause) }) }
            if (active) setAttempt(null)
            return
          }
        }
      } catch (cause) {
        if (!active) return
        setError({ key, message: messageForUser(cause) })
      }
      if (active) timer = setTimeout(() => { void poll() }, 500)
    }
    void poll()
    return () => { active = false; recoveryAbort.abort(); clearTimeout(timer) }
  }, [attempt, key, sessionId, online, route])

  const start = async (fresh: boolean) => {
    if (inFlight.current?.key === key || !online || (fresh && eligible !== key)) return
    // @@@reading-default(moment) - the version a restart must pass (a one-moment decision at the click): none seen yet = 0
    const afterVersion = view?.key === key ? view.value.version : lifeNow ? lifeNow.version : 0
    const request = { key, afterVersion }
    inFlight.current = request
    setAttempt(request)
    setBusy(key); setError(null); setView(null)
    try {
      const host = machineRpc(deviceId, local)
      if (fresh) {
        await host.sessions.restartSession(projectId, sessionId)
        restarted.current = request
      } else await host.sessions.lifeStart(sessionId)
    } catch (cause) {
      // Once the host has progressed, its lifecycle settles this attempt even if the RPC acknowledgement is lost.
      if (current.current === key && inFlight.current === request && observed.current !== request) {
        setAttempt(null); setError({ key, message: messageForUser(cause) })
      }
    } finally {
      if (inFlight.current === request) {
        inFlight.current = null
        if (current.current === key) setBusy(null)
      }
    }
  }
  const life = view?.key === key ? view.value : null
  const starting = life !== null && lifeIsStarting(life)
  const head = starting ? sessionInputBubbles([], life.pending.items, life.hold)[0] : null
  const row = head && life?.pending.items.find(item => item.messageId === head.id)
  const pendingPrompt: PendingPrompt | null = head?.state === 'sending'
    ? { id: head.id, text: head.text, starting: 'starting', held: true, ...(row?.sentAt !== undefined ? { sentAt: row.sentAt } : {}) }
    : null
  return {
    canStartFresh: missing && eligible === key && life?.kind !== 'failed' && life?.kind !== 'ready',
    busy: busy === key || (attempt?.key === key && life?.kind !== 'failed'),
    refreshing: attempt?.key === key && life?.kind === 'ready',
    pendingPrompt,
    error: error?.key === key ? error.message : life?.failure?.message ?? null,
    startFresh: () => start(true),
    retry: life?.kind === 'failed' ? () => start(false) : null,
  }
}
