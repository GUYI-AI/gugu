import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isDeepEqual } from '@gugu/session-shared'
import { remoteFailureKind, type NativeSessionRecord } from '@gugu/session-core/session-record/contract'
import { machineRpc, onLinkChange } from './sessionpage-rpc'
import { messageForUser } from '@/lib/userFacingError'
import { useStructurallyShared } from '@/hooks/useStructurallyShared'
import { hydrateCachedNativeRecord, readCachedNativeRecord, writeCachedNativeRecord } from './timeline-cache'
import { recoverTimelineRead } from './timeline-read-recovery'
import { checkNativeRevisions, fillNativeRecordTurns, heldTurnOf, keepsRevisions, mergeNativeRecordPage, projectNativeRecord, replaceNativeRecordTurns } from './native-record-state'

/** How many of the newest held turns every poll checks: the ones a host still rewrites (late tails, outcomes). */
const RECENT_CHECK = 30
/** More changed turns than this are read as the newest page instead, one by one would be slower. */
const MAX_STALE = 40

/** ACP records come from the task page archive, not a second parse of the provider's JSONL. */
export function useNativeSessionRecord(deviceId: string, sessionId: string, enabled: boolean, online: boolean, local = false) {
  // What this phone read last time is drawn first, and is all there is while that machine is away.
  const [record, setRecord] = useState<NativeSessionRecord | null>(() => enabled ? readCachedNativeRecord({ deviceId, sessionId }) : null)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  /** The last read failed because that machine did not answer (not because it refused): the page says it is away. */
  const [unreachable, setUnreachable] = useState(false)
  const epoch = useRef(0)
  const recoveryAbort = useRef(new AbortController())
  const key = `${deviceId}/${sessionId}`
  const [confirmed, setConfirmed] = useState<{ key: string; epoch: number } | null>(null)
  const connected = useRef(online)
  const current = useRef({ deviceId, sessionId, enabled, online })
  current.current = { deviceId, sessionId, enabled, online }
  const value = useRef(record)
  value.current = record
  const requests = useRef<Promise<void>>(Promise.resolve())
  // What the next read of the newest page is for: `true` replaces what is held, `'resume'` (the connection came back
  // under a reader who may be pages up) keeps it when the newest page reaches it (`mergeNativeRecordPage`).
  const tailRequested = useRef<boolean | 'resume'>(true)
  const shownKey = useRef<string | null>(null)
  /** The stored record, read from this phone's database: the first read waits for it, so it decides from what is kept. */
  const hydration = useRef<Promise<void>>(Promise.resolve())
  /** The next check covers every held turn, not just the newest: the page was (re)opened, or the link came back. */
  const checkAll = useRef(true)
  useEffect(() => {
    const connectionEpoch = epoch
    const generation = ++connectionEpoch.current
    recoveryAbort.current.abort(); recoveryAbort.current = new AbortController()
    connected.current = online; setConfirmed(null)
    // Reconcile the latest page first, even when the cache or host's first unread is far behind.
    requests.current = Promise.resolve()
    // The same conversation coming back online is not a new opening: what the reader has loaded stays in hand (the
    // cache keeps at most 4MB of it), and the newest page is merged into it.
    const resumed = enabled && shownKey.current === key && !!value.current
    shownKey.current = enabled ? key : null
    if (resumed) { if (tailRequested.current !== true) tailRequested.current = 'resume'; setError(null); setErrorCode(null) }
    else tailRequested.current = true
    checkAll.current = true
    const cached = resumed ? value.current : enabled ? readCachedNativeRecord({ deviceId, sessionId }) : null
    if (!resumed) { value.current = cached; setRecord(cached); setError(null); setErrorCode(null) }
    hydration.current = enabled && !cached ? hydrateCachedNativeRecord({ deviceId, sessionId }).then((stored) => {
      if (!stored || epoch.current !== generation || value.current) return
      value.current = stored; setRecord(stored)
    }) : Promise.resolve()
    return () => { connectionEpoch.current++; recoveryAbort.current.abort() }
  }, [deviceId, sessionId, key, enabled, online])
  const read = useCallback((mode: 'poll' | 'older' | 'newer' | 'tail' = 'poll') => {
    const ownEpoch = epoch.current
    const signal = recoveryAbort.current.signal
    const nextRequest = requests.current.catch(() => undefined).then(async () => {
      await hydration.current
      if (epoch.current !== ownEpoch || !connected.current || !current.current.enabled || !current.current.online) return
      const requested = current.current
      const previous = value.current
      const last = previous?.turns.at(-1)?.seq
      const intent = tailRequested.current
      let tail: boolean | 'resume' = mode !== 'older' && (mode === 'tail' || intent !== false) ? (intent === 'resume' ? 'resume' : true) : false
      const fetchPage = (input: { before?: number; after?: number; tail?: boolean; revisionsFrom?: number }) => recoverTimelineRead(async () => {
        const result = await machineRpc(deviceId, local).sessionTimeline.sessionNativeRecord({ conversationId: sessionId, ...input, lean: 'folded' })
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
        return result.value
      }, signal, () => { if (epoch.current === ownEpoch) setConfirmed(null) })
      const stillWanted = () => epoch.current === ownEpoch && current.current.deviceId === requested.deviceId && current.current.sessionId === requested.sessionId && current.current.enabled
      // @@@keep-what-was-read — the turns this phone holds (stored on it, drawn before anything is asked) are not read
      // again. Opening, polling and returning to the bottom ask only for the turns after the newest held one, with the
      // host's revision of each held turn; the few the host rewrote since are read again one by one. Opening checks
      // every held turn, a poll the newest few (the ones a host still rewrites). A holder from before revisions, a
      // host from before them, a new generation (an undo) or a gap wider than a page read the newest page as before.
      const checking = mode !== 'older' && keepsRevisions(previous) && !previous.hasNewer && (tail !== false || mode === 'poll')
      let merged: NativeSessionRecord | null = null
      if (checking) {
        const all = checkAll.current
        const from = all ? previous.turns[0]!.seq : previous.turns.at(-RECENT_CHECK)?.seq ?? previous.turns[0]!.seq
        const page = await fetchPage({ after: last, revisionsFrom: from })
        if (!stillWanted()) return
        const revisions = page.revisions
        // Against what is held now: a folded turn may have been filled in while this read was out.
        const check = () => {
          const now = value.current
          const sameHistory = (now?.nativeOwnerNotificationEpoch ?? 0) === (page.nativeOwnerNotificationEpoch ?? 0)
          const held = revisions && now && sameHistory && !(tail !== false && page.hasNewer) ? mergeNativeRecordPage(now, page, 'newer', false) : null
          return revisions && keepsRevisions(held) ? checkNativeRevisions(held, revisions, from) : null
        }
        const checked = check()
        if (checked) {
          if (checked.stale.length <= MAX_STALE) {
            const reread = await Promise.all(checked.stale.map(seq => recoverTimelineRead(async () => {
              const result = await machineRpc(deviceId, local).sessionTimeline.sessionNativeRecord({ conversationId: sessionId, before: seq + 1, limit: 1, lean: true })
              if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
              return result.value
            }, signal)))
            if (!stillWanted()) return
            const settled = checked.stale.length ? check() : checked
            merged = settled && checked.stale.length ? replaceNativeRecordTurns(settled.record, checked.stale, reread) : settled?.record ?? null
            if (merged && all) checkAll.current = false
            if (merged && tail) tailRequested.current = false
          }
        }
        // Not to be squared with what is held this way: the newest page, merged when it reaches what is held.
        if (!merged && tail === false) tail = 'resume'
      }
      if (!merged) {
        const input = mode === 'older' ? { before: previous?.nextCursor ?? undefined }
          : tail ? { tail: true } : (mode === 'newer' || previous?.hasNewer) && last !== undefined ? { after: last }
          : last !== undefined ? { after: Math.max(-1, last - 29) } : {}
        const page = await fetchPage(input)
        if (!stillWanted()) return
        if (tail) { tailRequested.current = false; checkAll.current = false }
        merged = mergeNativeRecordPage(value.current, page, mode, tail)
      }
      const next = isDeepEqual(value.current, merged) ? value.current! : merged
      if (next !== value.current) writeCachedNativeRecord({ deviceId, sessionId }, next)
      value.current = next; setRecord(next)
      if (mode !== 'older') setConfirmed(previous => previous?.key === key && previous.epoch === ownEpoch ? previous : { key, epoch: ownEpoch })
      setError(null); setErrorCode(null); setUnreachable(false)
    })
    requests.current = nextRequest
    return nextRequest.catch(error => {
      if (epoch.current !== ownEpoch) return
      setConfirmed(null); throw error
    })
  }, [deviceId, sessionId, local, key])
  useEffect(() => {
    if (!enabled || !online || local) return
    return onLinkChange(deviceId, open => {
      recoveryAbort.current.abort(); recoveryAbort.current = new AbortController()
      epoch.current++; connected.current = open; requests.current = Promise.resolve(); setConfirmed(null)
      if (tailRequested.current !== true) tailRequested.current = 'resume'
      checkAll.current = true
      if (open) { const ownEpoch = epoch.current; void read('tail').catch(error => { if (epoch.current === ownEpoch) setError(messageForUser(error)) }) }
    })
  }, [deviceId, enabled, online, local, read])
  useEffect(() => {
    if (!enabled || !online) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try { if (document.visibilityState !== 'hidden') await read() } catch (error) {
        if (!active) return
        setError(messageForUser(error))
        const code = (error as { code?: unknown } | null)?.code
        setErrorCode(typeof code === 'string' ? code : null)
        setUnreachable(remoteFailureKind(typeof code === 'string' ? code : null) === 'machine-unreachable')
      }
      if (active) timer = setTimeout(() => { void poll() }, 1000)
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [enabled, online, read])
  const heldWanted = useRef(new Set<number>())
  const heldReading = useRef(new Set<number>())
  const heldTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * A row has come on screen from behind a fold. A page gone back for carries a turn as its folded form: read that
   * turn again and put it in its place. Those pages are not read again behind the reader, so it stays whole.
   * Opening an exchange brings many rows on screen at once: their turns are read together and land as one change.
   */
  const fillHeldTurn = useCallback((itemId: string) => {
    const held = heldTurnOf(value.current, itemId)
    if (!held || heldReading.current.has(held.seq)) return
    heldWanted.current.add(held.seq)
    heldTimer.current ??= setTimeout(() => {
      heldTimer.current = null
      const wanted = [...heldWanted.current], ownEpoch = epoch.current
      heldWanted.current.clear()
      for (const seq of wanted) heldReading.current.add(seq)
      void Promise.all(wanted.map(seq => machineRpc(deviceId, local).sessionTimeline
        .sessionNativeRecord({ conversationId: sessionId, before: seq + 1, limit: 1, lean: true }).catch(() => null)))
        .then(results => {
          if (epoch.current !== ownEpoch) return
          const next = fillNativeRecordTurns(value.current, results.flatMap(result => result?.ok ? [result.value] : []))
          if (!next || next === value.current) return
          writeCachedNativeRecord({ deviceId, sessionId }, next)
          value.current = next; setRecord(next)
        })
        .finally(() => { for (const seq of wanted) heldReading.current.delete(seq) })
    }, 30)
  }, [deviceId, sessionId, local])
  const report = (error: unknown) => setError(messageForUser(error))
  // Wire pages and notification projection recreate unchanged turns; the transcript syncs by identity.
  const shown = useStructurallyShared(useMemo(() => projectNativeRecord(record), [record]))
  return { record: shown, error, errorCode, unreachable, ready: enabled && online && confirmed?.key === key && confirmed.epoch === epoch.current,
    reload: () => read('tail'),
    loadOlder: async () => { if (value.current?.nextCursor !== null && value.current?.nextCursor !== undefined) await read('older') },
    loadNewer: () => { if (value.current?.hasNewer) void read('newer').catch(report) },
    followTail: () => { tailRequested.current = true; if (online) void read('tail').catch(report) },
    fillHeldTurn,
  }
}
