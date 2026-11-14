// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTypingDiagnosticsRecorder } from '../../../../apps/desktop/src/lib/typing-diagnostics-recorder'
import type { TypingDiagnosticRecord } from '../../../../apps/desktop/shared/beta-typing-diagnostics'

let recorder: ReturnType<typeof createTypingDiagnosticsRecorder> | null = null
afterEach(() => { recorder?.stop(); recorder = null; document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function setup() {
  vi.useFakeTimers()
  const sampling = vi.fn(() => { throw new Error('sampling must not start') })
  vi.stubGlobal('Profiler', sampling)
  const callbacks = new Map<string, (entries: object[]) => void>(), disconnects: ReturnType<typeof vi.fn>[] = []
  const options: PerformanceObserverInit[] = []
  vi.stubGlobal('PerformanceObserver', class {
    static supportedEntryTypes = ['longtask', 'long-animation-frame', 'event']
    disconnect = vi.fn()
    constructor(private callback: (list: { getEntries(): object[] }) => void) { disconnects.push(this.disconnect) }
    observe(option: PerformanceObserverInit) { options.push(option); callbacks.set(option.type!, entries => this.callback({ getEntries: () => entries })) }
  })
  const add = vi.spyOn(window, 'addEventListener')
  let clock = 0
  vi.spyOn(window.performance, 'now').mockImplementation(() => clock)
  const rows: TypingDiagnosticRecord[] = []
  const send = vi.fn(async (records: TypingDiagnosticRecord[]) => { rows.push(...records); return { accepted: true } })
  recorder = createTypingDiagnosticsRecorder(window, send)
  const input = document.createElement('input'); document.body.append(input)
  Object.defineProperty(input, 'value', { get() { throw new Error('value must never be read') } })
  const deliver = (type: string, event: object) => {
    const listener = add.mock.calls.find(call => call[0] === type)![1] as (event: Event) => void
    listener({ target: input, composedPath: () => [input], type, isTrusted: true, timeStamp: clock, get key() { throw new Error('key must never be read') }, get data() { throw new Error('data must never be read') }, ...event } as unknown as Event)
  }
  return { callbacks, disconnects, options, rows, send, input, deliver, sampling, setClock: (value: number) => { clock = value } }
}

describe('main-window typing observations', () => {
  it('retrospectively connects a queued editable key to a 50ms task without reading input', async () => {
    const t = setup()
    t.callbacks.get('longtask')!([{ name: 'self', startTime: 50, duration: 100, attribution: [{ containerType: 'window', get containerSrc() { throw new Error('private URL') } }] }, { startTime: 0, duration: 49 }])
    t.setClock(185); t.deliver('keydown', { timeStamp: 100, isComposing: true })
    t.callbacks.get('event')!([{ name: 'keydown', startTime: 100, duration: 112, processingStart: 180, processingEnd: 190, get target() { throw new Error('target identity must never be read') } }])
    await recorder!.flush()
    expect(t.rows.find(row => row.event === 'long-task')).toMatchObject({ durationMs: 100, typingActive: true, typingOverlap: true, typingContextComplete: true })
    expect(t.rows.filter(row => row.event === 'long-task')).toHaveLength(1)
    expect(t.rows.find(row => row.event === 'key-latency')).toMatchObject({ metric: 'event-timing-next-paint', latencyMs: 112, captureDelayMs: 85, processingDelayMs: 80, processingMs: 10, presentationDelayMs: 22, composing: true })
    expect(t.rows.find(row => row.event === 'start')).toMatchObject({ eventThresholdMs: 16, eventResolutionMs: 8 })
    expect(t.options.find(option => option.type === 'event')).toMatchObject({ durationThreshold: 16 })
    expect(t.sampling).not.toHaveBeenCalled()
  })

  it('sanitizes script attribution and distinguishes an available presentation timestamp', async () => {
    const t = setup(); t.setClock(100); t.deliver('keydown', { timeStamp: 95 })
    t.callbacks.get('event')!([{ name: 'keydown', startTime: 95, duration: 48, processingStart: 100, processingEnd: 110, paintTime: 130, presentationTime: 143.5 }])
    t.callbacks.get('long-animation-frame')!([{ name: 'long-animation-frame', startTime: 50, duration: 100, scripts: [{ sourceURL: 'gugu-app://app/assets/main.js?PRIVATE_QUERY', sourceFunctionName: 'render', duration: 60, get invoker() { throw new Error('selector must not be read') } }, { sourceURL: 'https://external.invalid/PRIVATE_BODY.js', sourceFunctionName: 'PRIVATE_NAME' }] }])
    await recorder!.flush()
    expect(t.rows.find(row => row.event === 'key-latency')).toMatchObject({ metric: 'event-timing-presentation', durationMs: 48, latencyMs: 48.5, paintTimeMs: 130, presentationTimeMs: 143.5 })
    expect(t.rows.find(row => row.event === 'long-frame')).toMatchObject({ scripts: [{ file: 'assets/main.js', functionName: 'render', durationMs: 60 }], typingActive: true })
    expect(JSON.stringify(t.rows)).not.toContain('PRIVATE_')
  })

  it('records available frame phase intervals without inventing script or paint durations', async () => {
    const t = setup()
    t.callbacks.get('long-animation-frame')!([{ startTime: 50, duration: 210, renderStart: 150, styleAndLayoutStart: 200, styleDuration: 22, layoutDuration: 24, paintTime: 260, presentationTime: 266, scripts: [] }])
    await recorder!.flush()
    expect(t.rows.find(row => row.event === 'long-frame')).toMatchObject({ preRenderMs: 100, renderCallbackMs: 50, styleLayoutRenderMs: 60, styleDurationMs: 22, layoutDurationMs: 24, paintTimeMs: 260, presentationTimeMs: 266, scripts: [] })
    expect(t.rows.find(row => row.event === 'long-frame')).not.toHaveProperty('paintDurationMs')
    expect(t.sampling).not.toHaveBeenCalled()
  })

  it('records composition/blur metadata without reading composition data or changing the event', async () => {
    const t = setup(); t.setClock(100)
    t.deliver('compositionstart', {})
    t.deliver('blur', {})
    t.deliver('compositionend', { isTrusted: false })
    await recorder!.flush()
    expect(t.rows.filter(row => ['composition-start', 'composition-end', 'input-blur'].includes(row.event))).toMatchObject([{ event: 'composition-start', composing: true }, { event: 'input-blur', composing: true }, { event: 'composition-end', composing: false, trusted: false }])
    recorder!.stop()
    expect(t.disconnects.every(disconnect => disconnect.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('marks lost typing context unknown rather than claiming no input, and counts record drops', async () => {
    const t = setup()
    t.callbacks.get('longtask')!([{ name: 'self', startTime: 0, duration: 50 }])
    for (let i = 0; i < 300; i++) { t.setClock(2000 + i); t.deliver('keydown', {}) }
    for (let i = 0; i < 300; i++) t.callbacks.get('longtask')!([{ name: 'self', startTime: 5000 + i, duration: 50 }])
    await recorder!.flush()
    const oldest = t.rows.find(row => row.event === 'long-task')!
    expect(oldest.typingContextComplete).toBe(false)
    expect(oldest).not.toHaveProperty('typingActive')
    expect(t.rows.find(row => row.event === 'suppressed')).toMatchObject({ recordsDropped: expect.any(Number) })
    expect(t.send.mock.calls[0][0].length).toBeLessThanOrEqual(64)
  })

  it('stops its observers after storage failure instead of logging through a different outlet', async () => {
    const t = setup()
    t.send.mockResolvedValueOnce({ accepted: false })
    await recorder!.flush()
    expect(t.disconnects.every(disconnect => disconnect.mock.calls.length === 1)).toBe(true)
    t.callbacks.get('longtask')!([{ startTime: 1, duration: 500 }])
    await recorder!.flush()
    expect(t.send).toHaveBeenCalledOnce()
  })

  it('disconnects a failing entry reader without retaining its exception', async () => {
    const t = setup()
    t.callbacks.get('longtask')!([{ get duration() { throw new Error('PRIVATE_BROWSER_ERROR') } }])
    await recorder!.flush()
    expect(t.rows.find(row => row.event === 'observer-error')).toMatchObject({ observer: 'longtask' })
    expect(t.disconnects[0]).toHaveBeenCalledOnce()
    expect(JSON.stringify(t.rows)).not.toContain('PRIVATE_BROWSER_ERROR')
    expect(t.sampling).not.toHaveBeenCalled()
  })
})
