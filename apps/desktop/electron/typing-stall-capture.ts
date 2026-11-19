import { typingScriptFrame, type TypingDiagnosticRecord, type TypingScriptFrame } from '../shared/beta-typing-diagnostics'

export type TypingCaptureRecord = Record<string, unknown> & { event: 'capture-status' | 'profile' }

interface DebugPort {
  isAttached(): boolean
  attach(version?: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  removeListener(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
}
export interface TypingCaptureTarget {
  id: number
  getOSProcessId(): number
  isDestroyed(): boolean
  isDevToolsOpened(): boolean
  getURL(): string
  debugger: DebugPort
}
interface Host {
  contents(): TypingCaptureTarget | null
  write(record: TypingCaptureRecord): Promise<boolean>
  mono?: () => number
  wall?: () => number
}
interface Task { sequence: number; wallStartMs: number; durationMs: number }
interface Capture {
  index: number
  target: TypingCaptureTarget
  port: DebugPort
  trigger: TypingDiagnosticRecord
  attached: boolean
  finishing: boolean
  requestAt: number
  startSentAt: number
  startConfirmedAt: number
  startMono: number
  timer: ReturnType<typeof setTimeout> | null
  detached: (event: unknown, reason: string) => void
}
const DURATION = 30_000, COOLDOWN = 300_000, LIMIT = 6, INTERVAL_US = 100_000
const object = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0

/** CDP offsets have their own clock. Wall-clock bounds retain command uncertainty. */
export function cdpTypingSamples(value: unknown, tasks: readonly Task[], sentAt: number, confirmedAt: number) {
  const profile = object(value)
  if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas) || profile.nodes.length > 60_000) return null
  const nodes = new Map<number, Record<string, unknown>>(), parents = new Map<number, number>()
  for (const raw of profile.nodes) {
    const node = object(raw)
    if (!node || !Number.isSafeInteger(node.id)) continue
    nodes.set(node.id as number, node)
    if (Array.isArray(node.children)) for (const child of node.children) if (Number.isSafeInteger(child)) parents.set(child, node.id as number)
  }
  let elapsedUs = 0, nearby = 0
  const samples: Array<{ offsetMs: number; stack: TypingScriptFrame[]; stackTruncated: boolean }> = []
  for (let i = 0; i < Math.min(profile.samples.length, 400); i++) {
    const delta = profile.timeDeltas[i]
    if (typeof delta !== 'number' || !Number.isFinite(delta) || Math.abs(delta) > 60_000_000) return null
    elapsedUs += delta
    if (elapsedUs < 0) continue
    if (elapsedUs > 60_000_000) return null
    const offsetMs = elapsedUs / 1_000
    const near = tasks.some(task => sentAt + offsetMs <= task.wallStartMs + task.durationMs + 150 && confirmedAt + offsetMs >= task.wallStartMs - 150)
    if (!near) continue
    nearby++
    if (samples.length >= 8) continue
    const stack: TypingScriptFrame[] = [], visited = new Set<number>()
    let id: number | undefined = Number.isSafeInteger(profile.samples[i]) ? profile.samples[i] as number : undefined
    for (let depth = 0; id !== undefined && depth < 48 && stack.length < 12 && !visited.has(id); depth++) {
      visited.add(id)
      const node = nodes.get(id), frame = object(node?.callFrame)
      if (!node) break
      const safe = frame && typingScriptFrame({ file: frame.url, functionName: frame.functionName, line: finite(frame.lineNumber) ? frame.lineNumber + 1 : undefined, column: finite(frame.columnNumber) ? frame.columnNumber + 1 : undefined })
      if (safe) stack.push(safe)
      id = parents.get(id)
    }
    samples.push({ offsetMs, stack: stack.reverse(), stackTruncated: id !== undefined })
  }
  const intervals = profile.timeDeltas.slice(0, 400).filter(finite).map(value => value / 1_000).sort((a, b) => a - b)
  const profileSpanMs = finite(profile.startTime) && finite(profile.endTime) && profile.endTime >= profile.startTime ? (profile.endTime - profile.startTime) / 1_000 : undefined
  return { profileSpanMs, effectiveIntervalMedianMs: intervals.length ? intervals[Math.floor(intervals.length / 2)] : undefined, totalSamples: profile.samples.length, samplesOmitted: Math.max(0, nearby - samples.length), samples, clockUncertaintyMs: Math.max(0, confirmedAt - sentAt) }
}

/** No target/debugger lookup, native attachment, profiler or timer before an incident. */
export function createMainTypingCapture(host: Host) {
  const mono = host.mono ?? (() => performance.now()), wall = host.wall ?? Date.now
  const tasks: Task[] = [], delayed = new Set<ReturnType<typeof setTimeout>>()
  let active: Capture | null = null, captures = 0, nextAt = -Infinity, disabled = false
  const write = async (record: TypingCaptureRecord) => { try { return await host.write(record) } catch { return false } }
  const status = (trigger: TypingDiagnosticRecord, index: number, state: string, fields: Record<string, unknown> = {}): TypingCaptureRecord => ({ event: 'capture-status', pageId: trigger.pageId, timeOrigin: trigger.timeOrigin, triggerSequence: trigger.sequence, rendererPid: trigger.rendererPid, capture: index, status: state, ...fields })
  const cleanup = (capture: Capture) => {
    if (capture.timer !== null) clearTimeout(capture.timer)
    capture.timer = null
    try { capture.port.removeListener('detach', capture.detached) } catch { /* Target may have closed. */ }
    // The detach event revokes ownership. A later DevTools connection is never ours.
    if (capture.attached) {
      capture.attached = false
      try { if (capture.port.isAttached()) capture.port.detach() } catch { /* Target may have closed. */ }
    }
    if (active === capture) active = null
    nextAt = mono() + COOLDOWN
  }
  const command = async (capture: Capture, method: string, params?: Record<string, unknown>) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([capture.port.sendCommand(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CDP command timeout')), 1_000) })])
    } finally { if (timer !== null) clearTimeout(timer) }
  }
  const finish = async (capture: Capture, keep: boolean, reason?: string) => {
    if (active !== capture || capture.finishing) return
    capture.finishing = true
    if (capture.timer !== null) clearTimeout(capture.timer)
    capture.timer = null
    let profile: unknown = null, failed = false
    try {
      if (capture.startSentAt && capture.attached && capture.port.isAttached()) {
        const reply = object(await command(capture, 'Profiler.stop'))
        if (keep) profile = reply?.profile
      }
    } catch { failed = true }
    finally {
      if (capture.attached) { try { if (capture.port.isAttached()) await command(capture, 'Profiler.disable') } catch { /* Always release the connection below. */ } }
      cleanup(capture)
    }
    if (disabled) return
    const endedAt = wall(), durationMs = Math.max(0, mono() - capture.startMono)
    if (!await write(status(capture.trigger, capture.index, keep && profile && !failed ? 'complete' : 'interrupted', { reason: failed ? 'protocol-error' : reason, requestAt: capture.requestAt, captureStartAt: capture.startConfirmedAt, captureEndAt: endedAt, durationMs }))) { disabled = true; return }
    if (!profile || failed) return
    // Release the native connection before waiting for queued long-task batches.
    const timer = setTimeout(() => {
      delayed.delete(timer)
      if (disabled) return
      let result: ReturnType<typeof cdpTypingSamples> = null
      try { result = cdpTypingSamples(profile, tasks, capture.startSentAt, capture.startConfirmedAt) } catch { disabled = true }
      if (!result && !disabled) void write(status(capture.trigger, capture.index, 'interrupted', { reason: 'invalid-profile' }))
      if (result) void write({ event: 'profile', pageId: capture.trigger.pageId, timeOrigin: capture.trigger.timeOrigin, capture: capture.index, rendererPid: capture.trigger.rendererPid, requestAt: capture.requestAt, captureStartAt: capture.startConfirmedAt, ...result }).then(ok => { if (!ok) disabled = true })
    }, 1_100)
    delayed.add(timer)
  }
  const begin = async (senderId: number, trigger: TypingDiagnosticRecord) => {
    if (disabled || active || captures >= LIMIT || mono() < nextAt) return
    const index = captures + 1
    nextAt = mono() + COOLDOWN
    let target: TypingCaptureTarget | null
    try { target = host.contents() } catch { target = null }
    if (!target || target.id !== senderId || target.getOSProcessId() !== trigger.rendererPid || target.isDestroyed() || !target.getURL().startsWith('gugu-app://app/')) { await write(status(trigger, index, 'skipped', { reason: 'target-unavailable' })); return }
    // Check both interfaces: an open DevTools frontend and an existing CDP client.
    if (target.isDevToolsOpened() || target.debugger.isAttached()) { await write(status(trigger, index, 'skipped', { reason: 'occupied' })); return }
    const capture: Capture = { index, target, port: target.debugger, trigger, attached: false, finishing: false, requestAt: wall(), startSentAt: 0, startConfirmedAt: 0, startMono: mono(), timer: null, detached: () => {} }
    capture.detached = () => {
      capture.attached = false
      if (!capture.finishing) void finish(capture, false, 'detached')
    }
    captures = index
    active = capture
    try {
      capture.port.attach('1.3'); capture.attached = true
      capture.port.on('detach', capture.detached)
      await command(capture, 'Profiler.enable')
      if (active !== capture || !capture.attached) return
      await command(capture, 'Profiler.setSamplingInterval', { interval: INTERVAL_US })
      if (active !== capture || !capture.attached) return
      capture.startSentAt = wall()
      await command(capture, 'Profiler.start')
      if (active !== capture || !capture.attached) return
      capture.startConfirmedAt = wall(); capture.startMono = mono()
      capture.timer = setTimeout(() => { void finish(capture, true) }, DURATION)
      if (!await write(status(trigger, index, 'started', { requestAt: capture.requestAt, captureStartAt: capture.startConfirmedAt, sampleIntervalMs: 100, profileDurationMs: DURATION, setupDurationMs: capture.startConfirmedAt - capture.requestAt }))) { disabled = true; await finish(capture, false, 'storage') }
    } catch {
      if (!capture.attached && !capture.startSentAt) {
        cleanup(capture)
        if (!await write(status(trigger, index, 'skipped', { reason: 'attach-unavailable' }))) disabled = true
      } else await finish(capture, false, 'protocol-error')
    }
  }
  return {
    observe(senderId: number, record: TypingDiagnosticRecord) {
      if (disabled || record.event !== 'long-task' || !finite(record.startMs) || !finite(record.durationMs) || !finite(record.timeOrigin) || !finite(record.sequence) || !finite(record.rendererPid)) return
      const wallStartMs = record.timeOrigin + record.startMs
      tasks.push({ sequence: record.sequence, wallStartMs, durationMs: record.durationMs })
      while (tasks.length > 64 || tasks[0]?.wallStartMs < wall() - 60_000) tasks.shift()
      if (record.durationMs >= 100 && record.typingActive === true && wallStartMs <= wall() + 1_000 && wall() - (wallStartMs + record.durationMs) <= 10_000) void begin(senderId, record).catch(() => { disabled = true; if (active) void finish(active, false, 'protocol-error') })
    },
    stop() {
      disabled = true
      for (const timer of delayed) clearTimeout(timer)
      delayed.clear()
      if (active) void finish(active, false, 'storage')
      tasks.length = 0
    },
  }
}
