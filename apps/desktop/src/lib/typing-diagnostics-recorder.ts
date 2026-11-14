import { sanitizeTypingDiagnosticRecord, TYPING_DIAGNOSTICS_BATCH, TYPING_DIAGNOSTICS_TYPING_WINDOW, type TypingDiagnosticRecord } from '../../shared/beta-typing-diagnostics'

interface TaskEntry extends PerformanceEntry { attribution?: Array<{ name?: string; containerType?: string }> }
interface ScriptEntry { sourceURL?: string; sourceFunctionName?: string; startTime?: number; duration?: number; executionStart?: number; forcedStyleAndLayoutDuration?: number; pauseDuration?: number; sourceCharPosition?: number }
interface FrameEntry extends PerformanceEntry { blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number; firstUIEventTimestamp?: number; scripts?: ScriptEntry[] }
interface InputEntry extends PerformanceEntry { processingStart: number; processingEnd: number; paintTime?: number; presentationTime?: number | null }
interface KeyTime { sequence: number; startMs: number; captureDelayMs: number; composing: boolean }
export type TypingDiagnosticReply = { accepted: boolean; reason?: string }

/** Scalar input timings only: no key/data/value/text, target references, selectors, or DOM scans. */
export function createTypingDiagnosticsRecorder(win: Window & typeof globalThis, send: (records: TypingDiagnosticRecord[]) => Promise<TypingDiagnosticReply>) {
  const pageId = win.crypto.randomUUID()
  const queue: TypingDiagnosticRecord[] = [], keys: KeyTime[] = []
  const observers: PerformanceObserver[] = []
  let sequence = 0, stopped = false, inFlight = false, composing = false, dropped = 0, keysObserved = 0, eventEntriesObserved = 0
  let writtenKeys = 0, writtenEntries = 0, keyHistoryDropped = 0
  let keysDiscardedThrough = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  const now = () => win.performance.now()
  const stamp = (time: number) => time > 1e12 ? time - win.performance.timeOrigin : time
  const schedule = () => { if (!stopped && timer === null) timer = setTimeout(() => { timer = null; void flush() }, 1_000) }
  const emit = (record: TypingDiagnosticRecord) => {
    if (stopped) return
    if (queue.length >= 256) { dropped++; return }
    const safe = sanitizeTypingDiagnosticRecord({ ...record, pageId, timeOrigin: win.performance.timeOrigin })
    if (safe) { queue.push(safe); schedule() }
  }
  const typing = (record: TypingDiagnosticRecord) => {
    if (record.event !== 'long-task' && record.event !== 'long-frame') return record
    const start = Number(record.startMs), end = start + Number(record.durationMs)
    const complete = keysDiscardedThrough < start - TYPING_DIAGNOSTICS_TYPING_WINDOW
    const active = keys.some(key => key.startMs >= start - TYPING_DIAGNOSTICS_TYPING_WINDOW && key.startMs <= end)
    const overlap = keys.some(key => key.startMs >= start && key.startMs <= end)
    return { ...record, typingContextComplete: complete, ...(complete || active ? { typingActive: active } : {}), ...(complete || overlap ? { typingOverlap: overlap } : {}) }
  }
  const take = () => {
    const records = queue.splice(0, TYPING_DIAGNOSTICS_BATCH - 2).map(typing)
    if (dropped) { records.push({ event: 'suppressed', pageId, timeOrigin: win.performance.timeOrigin, recordsDropped: dropped, keysObserved, eventEntriesObserved }); dropped = 0 }
    if (keysObserved !== writtenKeys || eventEntriesObserved !== writtenEntries) records.push({ event: 'typing-summary', pageId, timeOrigin: win.performance.timeOrigin, startMs: now(), keysObserved, eventEntriesObserved, keyHistoryDropped })
    return records
  }
  const flush = async () => {
    if (stopped || inFlight || (!queue.length && !dropped && keysObserved === writtenKeys && eventEntriesObserved === writtenEntries)) return
    inFlight = true
    const keyCount = keysObserved, entryCount = eventEntriesObserved
    const records = take()
    try {
      const reply = await send(records)
      if (!reply.accepted) {
        if (reply.reason === 'busy') dropped += records.length
        else stop()
      } else { writtenKeys = keyCount; writtenEntries = entryCount }
    } catch { stop() }
    finally { inFlight = false; if (!stopped && (queue.length || dropped || keysObserved !== writtenKeys || eventEntriesObserved !== writtenEntries)) schedule() }
    const before = now() - 60_000
    while (keys[0]?.startMs < before) keys.shift()
  }
  const editable = (event: Event) => {
    const target = event.composedPath()[0] ?? event.target
    if (target instanceof win.HTMLInputElement) return ['text', 'search', 'email', 'url', 'tel', 'number'].includes(target.type)
    return target instanceof win.HTMLTextAreaElement || target instanceof win.HTMLElement && target.isContentEditable
  }
  const keydown = (event: KeyboardEvent) => {
    if (!event.isTrusted || !editable(event)) return
    const startMs = stamp(event.timeStamp)
    keysObserved++
    keys.push({ sequence: ++sequence, startMs, captureDelayMs: Math.max(0, now() - startMs), composing: event.isComposing })
    if (keys.length > 256) { keysDiscardedThrough = keys.shift()!.startMs; keyHistoryDropped++ }
    schedule()
  }
  const composition = (event: CompositionEvent) => {
    if (!editable(event) || event.type === 'compositionstart' && !event.isTrusted) return
    composing = event.type === 'compositionstart'
    emit({ event: composing ? 'composition-start' : 'composition-end', startMs: stamp(event.timeStamp), composing, trusted: event.isTrusted })
  }
  const blur = (event: Event) => {
    if (composing || keys.some(key => now() - key.startMs <= TYPING_DIAGNOSTICS_TYPING_WINDOW)) emit({ event: 'input-blur', startMs: stamp(event.timeStamp), composing, trusted: event.isTrusted })
  }
  const observe = (type: string, read: (entry: PerformanceEntry) => void) => {
    if (!win.PerformanceObserver?.supportedEntryTypes?.includes(type)) return false
    try {
      const observer = new win.PerformanceObserver(list => {
        if (stopped) return
        try { for (const entry of list.getEntries()) read(entry) }
        catch { observer.disconnect(); emit({ event: 'observer-error', observer: type }) }
      })
      observer.observe({ type, ...(type === 'event' ? { durationThreshold: 16 } : {}) } as PerformanceObserverInit)
      observers.push(observer); return true
    } catch { return false }
  }
  const longTaskSupported = observe('longtask', raw => {
    const entry = raw as TaskEntry
    if (entry.duration < 50) return
    emit({ event: 'long-task', sequence: ++sequence, startMs: entry.startTime, durationMs: entry.duration, attribution: entry.attribution?.map(value => ({ container: value.containerType, scope: entry.name })) })
  })
  const longFrameSupported = observe('long-animation-frame', raw => {
    const entry = raw as FrameEntry
    if (entry.duration < 50) return
    emit({ event: 'long-frame', sequence: ++sequence, startMs: entry.startTime, durationMs: entry.duration, blockingMs: entry.blockingDuration, renderStartMs: entry.renderStart, styleAndLayoutStartMs: entry.styleAndLayoutStart, firstUIEventMs: entry.firstUIEventTimestamp,
      scriptsTotal: entry.scripts?.length, scripts: entry.scripts?.slice().sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0)).slice(0, 12).map(script => ({ file: script.sourceURL, functionName: script.sourceFunctionName, startMs: script.startTime, durationMs: script.duration, executionStartMs: script.executionStart, forcedStyleAndLayoutMs: script.forcedStyleAndLayoutDuration, pauseMs: script.pauseDuration, sourceOffset: script.sourceCharPosition })) })
  })
  const eventTimingSupported = observe('event', raw => {
    if (raw.name !== 'keydown') return
    const entry = raw as InputEntry
    const key = keys.find(value => Math.abs(value.startMs - entry.startTime) <= 1)
    if (!key) return
    eventEntriesObserved++
    const presented = typeof entry.presentationTime === 'number' && Number.isFinite(entry.presentationTime) && entry.presentationTime >= entry.startTime
    const end = presented ? entry.presentationTime! : entry.startTime + entry.duration
    emit({ event: 'key-latency', sequence: key.sequence, startMs: entry.startTime, durationMs: entry.duration, latencyMs: end - entry.startTime,
      metric: presented ? 'event-timing-presentation' : 'event-timing-next-paint', paintTimeMs: entry.paintTime, presentationTimeMs: presented ? entry.presentationTime : undefined,
      captureDelayMs: key.captureDelayMs, processingDelayMs: Math.max(0, entry.processingStart - entry.startTime), processingMs: Math.max(0, entry.processingEnd - entry.processingStart), presentationDelayMs: Math.max(0, end - entry.processingEnd), composing: key.composing, trusted: true, typingActive: true })
  })
  win.addEventListener('keydown', keydown, true)
  win.addEventListener('compositionstart', composition, true)
  win.addEventListener('compositionend', composition, true)
  win.addEventListener('blur', blur, true)
  emit({ event: 'start', timeOrigin: win.performance.timeOrigin, startMs: now(), longTaskSupported, longFrameSupported, eventTimingSupported, eventThresholdMs: 16, eventResolutionMs: 8, typingWindowMs: TYPING_DIAGNOSTICS_TYPING_WINDOW, visible: win.document.visibilityState === 'visible' })
  function stop(finalFlush = false) {
    if (stopped) return
    if (finalFlush && !inFlight && (queue.length || dropped || keysObserved !== writtenKeys || eventEntriesObserved !== writtenEntries)) { try { void send(take()).catch(() => undefined) } catch { /* App teardown never waits for the recorder. */ } }
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const observer of observers) observer.disconnect()
    win.removeEventListener('keydown', keydown, true)
    win.removeEventListener('compositionstart', composition, true)
    win.removeEventListener('compositionend', composition, true)
    win.removeEventListener('blur', blur, true)
    queue.length = 0; keys.length = 0
  }
  return { flush, stop }
}
