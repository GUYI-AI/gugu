// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTypingProfiler, profileNearTypingTasks } from '../../../../apps/desktop/src/lib/typing-diagnostics-profile'
import type { TypingDiagnosticRecord } from '../../../../apps/desktop/shared/beta-typing-diagnostics'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('incident-triggered typing capture', () => {
  it('does no idle sampling, captures once for thirty seconds, and waits five minutes after stopping', async () => {
    vi.useFakeTimers()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const stop = vi.fn(async () => ({ resources: [], frames: [], stacks: [], samples: [] }))
    const constructor = vi.fn()
    vi.stubGlobal('Profiler', class extends EventTarget { sampleInterval = 100; stop = stop; constructor() { super(); constructor() } })
    const rows: TypingDiagnosticRecord[] = [], claim = vi.fn(async () => ({ accepted: true }))
    const p = createTypingProfiler(window, () => [], row => rows.push(row), claim)
    expect(constructor).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    const task = { sequence: 4, startMs: 0, durationMs: 101 }
    await p.trigger(task)
    expect(constructor).toHaveBeenCalledOnce()
    await p.trigger(task); expect(claim).toHaveBeenCalledOnce()
    clock = 30_000; await vi.advanceTimersByTimeAsync(30_000)
    expect(stop).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    clock = 329_999; await p.trigger(task); expect(claim).toHaveBeenCalledOnce()
    clock = 330_000; await p.trigger(task); expect(claim).toHaveBeenCalledTimes(2)
    p.stop(); expect(stop).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    expect(rows.find(row => row.status === 'capturing')).toMatchObject({ triggerSequence: 4, sampleIntervalMs: 100, profileDurationMs: 30_000 })
  })

  it('does not start after teardown while its main-process claim is pending, or on denial', async () => {
    const constructor = vi.fn(); vi.stubGlobal('Profiler', constructor)
    let grant!: (reply: { accepted: boolean }) => void
    const p = createTypingProfiler(window, () => [], () => {}, () => new Promise(resolve => { grant = resolve }))
    const pending = p.trigger({ sequence: 1, startMs: 0, durationMs: 100 })
    p.stop(); grant({ accepted: true }); await pending
    expect(constructor).not.toHaveBeenCalled()
    const denied = createTypingProfiler(window, () => [], () => {}, async () => ({ accepted: false }))
    await denied.trigger({ sequence: 1, startMs: 0, durationMs: 100 }); denied.stop()
    expect(constructor).not.toHaveBeenCalled()
  })

  it('retains only bounded application frames near tasks and terminates cyclic tries', () => {
    const record = profileNearTypingTasks({ resources: ['gugu-app://app/assets/main.js?PRIVATE_QUERY', 'https://private.invalid/PRIVATE_PATH'], frames: [{ name: 'render', resourceId: 0 }, { name: 'PRIVATE_FUNCTION', resourceId: 1 }], stacks: [{ frameId: 0, parentId: 1 }, { frameId: 1, parentId: 0 }], samples: Array.from({ length: 20 }, (_, i) => ({ timestamp: i < 19 ? 200 : 10_000, stackId: 0 })) }, [{ sequence: 1, startMs: 150, durationMs: 100 }])!
    expect(record.samples).toHaveLength(8)
    expect(record.samplesOmitted).toBe(11)
    expect(JSON.stringify(record)).not.toContain('PRIVATE_')
  })
})
