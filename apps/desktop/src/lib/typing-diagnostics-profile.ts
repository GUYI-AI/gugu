import { TYPING_DIAGNOSTICS_PROFILE_INTERVAL, typingScriptFrame, type TypingDiagnosticRecord, type TypingScriptFrame } from '../../shared/beta-typing-diagnostics'

export interface TypingTaskRange { sequence: number; startMs: number; durationMs: number }
export interface TypingProfileTrace {
  resources: string[]
  frames: Array<{ name?: string; resourceId?: number; line?: number; column?: number }>
  stacks: Array<{ frameId: number; parentId?: number }>
  samples: Array<{ timestamp: number; stackId?: number; marker?: string }>
}
interface BrowserProfiler extends EventTarget { sampleInterval: number; stop(): Promise<TypingProfileTrace> }
type ProfilerWindow = Window & typeof globalThis & { Profiler?: new (options: { sampleInterval: number; maxBufferSize: number }) => BrowserProfiler }

/** Retain only bounded samples close to a task. The full V8 trie never crosses IPC. */
export function profileNearTypingTasks(trace: TypingProfileTrace, ranges: readonly TypingTaskRange[]): TypingDiagnosticRecord | null {
  const nearby = trace.samples.filter(sample => Number.isFinite(sample.timestamp) && ranges.some(range => sample.timestamp >= range.startMs - 150 && sample.timestamp <= range.startMs + range.durationMs + 150))
  if (!nearby.length) return null
  const samples = nearby.slice(0, 8).map(sample => {
    const stack: TypingScriptFrame[] = []
    let id = sample.stackId
    const visited = new Set<number>()
    for (let depth = 0; id !== undefined && depth < 12 && !visited.has(id); depth++) {
      visited.add(id)
      const node = trace.stacks[id]
      if (!node) break
      const frame = trace.frames[node.frameId]
      const safe = frame && typingScriptFrame({ file: frame.resourceId === undefined ? undefined : trace.resources[frame.resourceId], functionName: frame.name, line: frame.line, column: frame.column })
      if (safe) stack.push(safe)
      id = node.parentId
    }
    return { timestampMs: sample.timestamp, marker: sample.marker, stackTruncated: id !== undefined, stack: stack.reverse() }
  })
  return { event: 'profile', totalSamples: trace.samples.length, samplesOmitted: nearby.length - samples.length, taskSequences: ranges.filter(range => nearby.some(sample => sample.timestamp >= range.startMs - 150 && sample.timestamp <= range.startMs + range.durationMs + 150)).map(range => range.sequence), samples }
}

export function createTypingProfiler(win: Window & typeof globalThis, ranges: () => readonly TypingTaskRange[], emit: (record: TypingDiagnosticRecord) => void) {
  const Constructor = (win as ProfilerWindow).Profiler
  let profiler: BrowserProfiler | null = null, stopped = false, rotating = false, reported = false
  let interval: ReturnType<typeof setInterval> | null = null
  const delayed = new Set<ReturnType<typeof setTimeout>>()
  const full = () => { void rotate() }
  function stop() {
    stopped = true
    if (interval !== null) clearInterval(interval)
    interval = null
    for (const timer of delayed) clearTimeout(timer)
    delayed.clear()
    const previous = profiler; profiler = null
    if (previous) {
      try { previous.removeEventListener('samplebufferfull', full) } catch { /* A partial browser API is disabled below. */ }
      try { void previous.stop().catch(() => undefined) } catch { /* Never propagate optional profiler failures. */ }
    }
  }
  const start = () => {
    if (stopped) return
    if (!Constructor) { if (!reported) emit({ event: 'profile-status', status: 'unavailable' }); reported = true; return }
    try {
      profiler = new Constructor({ sampleInterval: TYPING_DIAGNOSTICS_PROFILE_INTERVAL, maxBufferSize: 256 })
      profiler.addEventListener('samplebufferfull', full)
      if (!reported) emit({ event: 'profile-status', status: 'enabled', sampleIntervalMs: profiler.sampleInterval })
      reported = true
    } catch (error) {
      emit({ event: 'profile-status', status: (error as { name?: string })?.name === 'NotAllowedError' ? 'policy-denied' : 'failed' })
      reported = true; stop()
    }
  }
  const rotate = async () => {
    if (stopped || rotating || !profiler) return
    rotating = true
    const previous = profiler; profiler = null
    previous.removeEventListener('samplebufferfull', full)
    try {
      const trace = await previous.stop()
      start()
      if (!stopped) {
        // Long-task and Event Timing observers may be delivered after the profiler callback.
        const timer = setTimeout(() => {
          delayed.delete(timer)
          if (!stopped) {
            try { const record = profileNearTypingTasks(trace, ranges()); if (record) emit(record) }
            catch { stop(); emit({ event: 'profile-status', status: 'failed' }) }
          }
        }, 1_000)
        delayed.add(timer)
      }
    } catch { stop(); emit({ event: 'profile-status', status: 'failed' }) }
    finally { rotating = false }
  }
  start()
  interval = !stopped && Constructor ? setInterval(() => { void rotate() }, 15_000) : null
  return {
    supported: typeof Constructor === 'function',
    stop,
  }
}
