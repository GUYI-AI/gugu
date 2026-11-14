import { TYPING_DIAGNOSTICS_PROFILE_INTERVAL, TYPING_DIAGNOSTICS_PROFILE_DURATION, TYPING_DIAGNOSTICS_PROFILE_COOLDOWN, TYPING_DIAGNOSTICS_PROFILE_LIMIT, typingScriptFrame, type TypingDiagnosticRecord, type TypingScriptFrame } from '../../shared/beta-typing-diagnostics'

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

export function createTypingProfiler(win: Window & typeof globalThis, ranges: () => readonly TypingTaskRange[], emit: (record: TypingDiagnosticRecord) => void, claim: () => Promise<{ accepted: boolean; capture?: number }>) {
  const Constructor = (win as ProfilerWindow).Profiler
  let profiler: BrowserProfiler | null = null, stopped = false, pending = false, unavailable = false
  let timer: ReturnType<typeof setTimeout> | null = null, nextAt = -Infinity, captures = 0
  const now = () => win.performance.now()
  const finish = async () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    const previous = profiler; profiler = null
    if (!previous) return
    previous.removeEventListener('samplebufferfull', full)
    nextAt = now() + TYPING_DIAGNOSTICS_PROFILE_COOLDOWN
    try {
      const trace = await previous.stop()
      if (stopped) return
      // Keep the API's bounded trie only until delivery of queued long-task entries.
      timer = setTimeout(() => {
        timer = null
        if (stopped) return
        try { const record = profileNearTypingTasks(trace, ranges()); if (record) emit({ ...record, capture: captures }) }
        catch { unavailable = true; emit({ event: 'profile-status', status: 'failed' }) }
      }, 1_000)
      emit({ event: 'profile-status', status: 'complete', capture: captures, startMs: now(), totalSamples: trace.samples.length })
    } catch { unavailable = true; if (!stopped) emit({ event: 'profile-status', status: 'failed' }) }
  }
  const full = () => { void finish() }
  const trigger = async (range: TypingTaskRange) => {
    if (stopped || pending || profiler || unavailable || captures >= TYPING_DIAGNOSTICS_PROFILE_LIMIT || now() < nextAt) return
    if (!Constructor) { unavailable = true; emit({ event: 'profile-status', status: 'unavailable' }); return }
    pending = true
    try {
      const grant = await claim()
      if (stopped) return
      if (!grant.accepted) { nextAt = now() + TYPING_DIAGNOSTICS_PROFILE_COOLDOWN; emit({ event: 'profile-status', status: 'denied' }); return }
      captures = grant.capture ?? captures + 1
      profiler = new Constructor({ sampleInterval: TYPING_DIAGNOSTICS_PROFILE_INTERVAL, maxBufferSize: 512 })
      profiler.addEventListener('samplebufferfull', full)
      nextAt = now() + TYPING_DIAGNOSTICS_PROFILE_DURATION + TYPING_DIAGNOSTICS_PROFILE_COOLDOWN
      timer = setTimeout(() => { void finish() }, TYPING_DIAGNOSTICS_PROFILE_DURATION)
      emit({ event: 'profile-status', status: 'capturing', capture: captures, triggerSequence: range.sequence, startMs: now(), sampleIntervalMs: profiler.sampleInterval, profileDurationMs: TYPING_DIAGNOSTICS_PROFILE_DURATION })
    } catch {
      unavailable = true
      const previous = profiler; profiler = null
      if (previous) { try { previous.removeEventListener('samplebufferfull', full); void previous.stop().catch(() => undefined) } catch { /* Optional browser API. */ } }
      emit({ event: 'profile-status', status: 'failed' })
    } finally { pending = false }
  }
  const stop = () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    const previous = profiler; profiler = null
    if (previous) { try { previous.removeEventListener('samplebufferfull', full); void previous.stop().catch(() => undefined) } catch { /* No teardown errors escape. */ } }
  }
  emit({ event: 'profile-status', status: 'armed', sampleIntervalMs: TYPING_DIAGNOSTICS_PROFILE_INTERVAL, profileDurationMs: TYPING_DIAGNOSTICS_PROFILE_DURATION, cooldownMs: TYPING_DIAGNOSTICS_PROFILE_COOLDOWN, captureLimit: TYPING_DIAGNOSTICS_PROFILE_LIMIT })
  return { trigger, stop, supported: typeof Constructor === 'function' }
}
