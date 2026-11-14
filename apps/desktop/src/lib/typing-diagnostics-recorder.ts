import { sanitizeTypingDiagnosticRecord, TYPING_DIAGNOSTICS_TYPING_WINDOW, type TypingDiagnosticRecord } from '../../shared/beta-typing-diagnostics'

export type TypingDiagnosticReply = { accepted: boolean; reason?: string }
interface Task { sequence: number; startMs: number; durationMs: number }

/** Incident trigger only. No Event Timing/LoAF observer, DOM polling, key text, or page profiler. */
export function createTypingDiagnosticsRecorder(win: Window & typeof globalThis, send: (records: TypingDiagnosticRecord[]) => Promise<TypingDiagnosticReply>) {
  const pageId = win.crypto.randomUUID(), keys: number[] = [], pending: Task[] = [], queue: TypingDiagnosticRecord[] = []
  let stopped = false, inFlight = false, sequence = 0, keysObserved = 0, keyHistoryDropped = 0, dropped = 0
  let timer: ReturnType<typeof setTimeout> | null = null, observer: PerformanceObserver | null = null
  const now = () => win.performance.now()
  const freshStats = () => ({ keyCallbacks: 0, taskCallbacks: 0, taskEntries: 0, keyCallbackMs: 0, taskCallbackMs: 0, flushCallbacks: 0, flushCallbackMs: 0, accountingCallbacks: 0, accountingCallbackMs: 0 })
  let stats = freshStats(), accountingStart = now()
  let accountingTimer: ReturnType<typeof setInterval> | null = null
  const stamp = (value: number) => value > 1e12 ? value - win.performance.timeOrigin : value
  const schedule = () => { if (!stopped && timer === null) timer = setTimeout(() => { timer = null; void flush() }, 0) }
  const emit = (record: TypingDiagnosticRecord) => {
    if (stopped) return
    if (queue.length >= 32) { dropped++; return }
    const safe = sanitizeTypingDiagnosticRecord({ ...record, pageId, timeOrigin: win.performance.timeOrigin })
    if (safe) { queue.push(safe); schedule() }
  }
  const take = () => {
    const batch = queue.splice(0, 32)
    if (dropped) { batch.push({ event: 'suppressed', pageId, timeOrigin: win.performance.timeOrigin, recordsDropped: dropped }); dropped = 0 }
    batch.push({ event: 'typing-summary', pageId, timeOrigin: win.performance.timeOrigin, keysObserved, keyHistoryDropped })
    return batch
  }
  const flush = async () => {
    if (stopped || inFlight || !queue.length && !dropped) return
    inFlight = true
    const prepareAt = now()
    const batch = take()
    stats.flushCallbacks++
    stats.flushCallbackMs += Math.max(0, now() - prepareAt)
    try {
      const replyPromise = (() => { const sentAt = now(); try { return send(batch) } finally { stats.flushCallbackMs += Math.max(0, now() - sentAt) } })()
      const reply = await replyPromise
      stats.flushCallbacks++
      if (!reply.accepted) { if (reply.reason === 'busy') dropped += batch.length; else stop() }
    } catch { stop() }
    finally { const at = now(); inFlight = false; if (!stopped && queue.length) schedule(); stats.flushCallbackMs += Math.max(0, now() - at) }
  }
  const reconcile = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const task = pending[i], end = task.startMs + task.durationMs
      if (now() - end > 2_000) { pending.splice(i, 1); continue }
      if (!keys.some(time => time >= task.startMs - TYPING_DIAGNOSTICS_TYPING_WINDOW && time <= end)) continue
      pending.splice(i, 1)
      emit({ event: 'long-task', ...task, typingActive: true, typingOverlap: keys.some(time => time >= task.startMs && time <= end), keysObserved })
    }
  }
  const keydown = (event: KeyboardEvent) => {
    const began = now()
    try {
      if (!event.isTrusted) return
      const target = event.composedPath()[0] ?? event.target
      const editable = target instanceof win.HTMLInputElement ? ['text', 'search', 'email', 'url', 'tel', 'number'].includes(target.type) : target instanceof win.HTMLTextAreaElement || target instanceof win.HTMLElement && target.isContentEditable
      if (!editable) return
      const time = stamp(event.timeStamp)
      if (!Number.isFinite(time)) return
      keysObserved++; keys.push(time)
      while (keys.length > 64) { keys.shift(); keyHistoryDropped++ }
      reconcile()
      // Ordinary keys create no IPC batch or timer.
    } finally { stats.keyCallbacks++; stats.keyCallbackMs += Math.max(0, now() - began) }
  }
  let longTaskSupported = false
  if (win.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
    try {
      observer = new win.PerformanceObserver(list => {
        if (stopped) return
        const began = now(); stats.taskCallbacks++
        try {
          for (const entry of list.getEntries()) {
            stats.taskEntries++
            if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration) || entry.duration < 50) continue
            pending.push({ sequence: ++sequence, startMs: entry.startTime, durationMs: entry.duration })
            if (pending.length > 16) pending.shift()
          }
          reconcile()
        } catch { observer?.disconnect(); emit({ event: 'observer-error', observer: 'longtask' }) }
        finally { stats.taskCallbackMs += Math.max(0, now() - began) }
      })
      observer.observe({ type: 'longtask' }); longTaskSupported = true
    } catch { observer?.disconnect(); observer = null }
  }
  const reportAccounting = (partial: boolean) => {
    const began = now(), snapshot = stats, startMs = accountingStart
    stats = freshStats(); accountingStart = began
    emit({ event: 'callback-accounting', startMs, durationMs: Math.max(0, began - startMs), partial, ...snapshot, totalOwnCallbackMs: snapshot.keyCallbackMs + snapshot.taskCallbackMs + snapshot.flushCallbackMs + snapshot.accountingCallbackMs })
    // This timer runs in the newly opened window; charge its work there.
    stats.accountingCallbacks++; stats.accountingCallbackMs += Math.max(0, now() - began)
  }
  accountingTimer = setInterval(() => reportAccounting(false), 60_000)
  win.addEventListener('keydown', keydown, true)
  emit({ event: 'start', startMs: now(), longTaskSupported, typingWindowMs: TYPING_DIAGNOSTICS_TYPING_WINDOW, visible: win.document.visibilityState === 'visible' })
  function stop(finalFlush = false) {
    if (stopped) return
    if (finalFlush && !inFlight) {
      // Do not start a capture from queued work while its document is closing.
      const summary: TypingDiagnosticRecord = { event: 'typing-summary', pageId, timeOrigin: win.performance.timeOrigin, keysObserved, keyHistoryDropped, recordsDropped: dropped + queue.length }
      try { void send([summary]).catch(() => undefined) } catch { /* Teardown never waits on diagnostics. */ }
    }
    stopped = true
    if (accountingTimer !== null) clearInterval(accountingTimer)
    accountingTimer = null
    if (timer !== null) clearTimeout(timer)
    timer = null; observer?.disconnect(); observer = null
    win.removeEventListener('keydown', keydown, true)
    keys.length = 0; pending.length = 0; queue.length = 0
  }
  return { flush, stop, reportAccounting }
}
