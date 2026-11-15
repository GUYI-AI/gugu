import type { FrameCounters } from '../session/shared/renderer-metrics'

// Long animation frames (>= 50 ms, the browser's own threshold) and interactions slower than 100 ms in this page,
// counted since load. The browser measures both anyway; the observers only add these few sums. Main reads and
// differences them (resource monitor), so nothing here resets, times or allocates per frame.
const SLOW_INTERACTION_MS = 100
let longFrames = 0
let blockingMs = 0
let slowInteractions = 0
let installed = false

type LoafEntry = PerformanceEntry & { blockingDuration?: number }
type EventEntry = PerformanceEntry & { interactionId?: number }

export function installFrameCounters(win: Pick<typeof globalThis, 'PerformanceObserver'> = globalThis): void {
  if (installed || typeof win.PerformanceObserver !== 'function') return
  installed = true
  const supported = win.PerformanceObserver.supportedEntryTypes ?? []
  try {
    if (supported.includes('long-animation-frame')) new win.PerformanceObserver((list) => {
      for (const entry of list.getEntries() as LoafEntry[]) { longFrames += 1; blockingMs += entry.blockingDuration ?? 0 }
    }).observe({ type: 'long-animation-frame' })
    // One interaction reports several events (pointerdown, pointerup, click) under one id: count it once.
    let lastSlow = 0
    if (supported.includes('event')) new win.PerformanceObserver((list) => {
      for (const entry of list.getEntries() as EventEntry[]) {
        if (!entry.interactionId || entry.duration < SLOW_INTERACTION_MS || entry.interactionId === lastSlow) continue
        lastSlow = entry.interactionId; slowInteractions += 1
      }
    }).observe({ type: 'event', durationThreshold: SLOW_INTERACTION_MS } as PerformanceObserverInit)
  } catch { /* An unsupported observer leaves its counter at zero; the page must still start. */ }
}

export function readFrameCounters(): FrameCounters {
  return { longFrames, blockingMs: Math.round(blockingMs), slowInteractions }
}
