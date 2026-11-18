// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTypingDiagnosticsRecorder } from '../../../../apps/desktop/src/lib/typing-diagnostics-recorder'
import type { TypingDiagnosticRecord } from '../../../../apps/desktop/shared/beta-typing-diagnostics'
let recorder: ReturnType<typeof createTypingDiagnosticsRecorder> | null = null
afterEach(() => { recorder?.stop(); recorder = null; document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function setup(taskWorkMs = 0) {
 vi.useFakeTimers(); let clock = 0
 vi.spyOn(performance, 'now').mockImplementation(() => clock)
 const options: PerformanceObserverInit[] = [], callbacks: Array<(entries: object[]) => void> = [], disconnect = vi.fn()
 vi.stubGlobal('PerformanceObserver', class {
  static supportedEntryTypes = ['longtask', 'long-animation-frame', 'event']
  constructor(callback: (list: { getEntries(): object[] }) => void) { callbacks.push(entries => callback({ getEntries: () => { clock += taskWorkMs; return entries } })) }
  observe(option: PerformanceObserverInit) { options.push(option) }
  disconnect = disconnect
 })
 const profiler = vi.fn(); vi.stubGlobal('Profiler', profiler)
 const add = vi.spyOn(window, 'addEventListener'), rows: TypingDiagnosticRecord[] = []
 const send = vi.fn(async (records: TypingDiagnosticRecord[]) => { rows.push(...records); return { accepted: true } })
 recorder = createTypingDiagnosticsRecorder(window, send)
 const input = document.createElement('input'); document.body.append(input)
 Object.defineProperty(input, 'value', { get() { throw new Error('PRIVATE_VALUE') } })
 const key = (fields: object = {}) => { const listener = add.mock.calls.find(x => x[0] === 'keydown')![1] as (event: Event) => void; listener({ target: input, composedPath: () => [input], isTrusted: true, timeStamp: clock, get key() { throw new Error('PRIVATE_KEY') }, get data() { throw new Error('PRIVATE_DATA') }, ...fields } as unknown as Event) }
 return { options, rows, send, key, profiler, disconnect, input, task: callbacks[0], clock: (value: number) => { clock = value } }
}
describe('incident-only renderer trigger', () => {
 it('observes only long tasks and leaves normal keys without timers or IPC', async () => {
  const t = setup(); await recorder!.flush(); await vi.advanceTimersByTimeAsync(1)
  expect(t.options).toEqual([{ type: 'longtask' }]); const n = t.send.mock.calls.length
  t.clock(100); t.key(); t.task([{ startTime: 100, duration: 49 }]); await vi.advanceTimersByTimeAsync(10)
  expect(t.send).toHaveBeenCalledTimes(n); expect(t.profiler).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1) // minute accounting only
 })
 it('retroactively associates a queued trusted key with a task, without reading text', async () => {
  const t = setup(); t.clock(210); t.task([{ startTime: 50, duration: 150, get attribution() { throw new Error('PRIVATE_ATTRIBUTION') } }]); t.clock(230); t.key({ timeStamp: 100 }); await recorder!.flush()
  expect(t.rows.find(x => x.event === 'long-task')).toMatchObject({ startMs: 50, durationMs: 150, typingActive: true, typingOverlap: true })
  expect(JSON.stringify(t.rows)).not.toContain('PRIVATE_'); expect(t.profiler).not.toHaveBeenCalled()
 })
 it('does not trigger for expired tasks, untrusted input or password fields', async () => {
  const t = setup(); t.task([{ startTime: 0, duration: 150 }]); t.clock(5000); t.key(); t.key({ isTrusted: false }); t.input.type = 'password'; t.key(); t.clock(7000); t.task([{ startTime: 7000, duration: 150 }]); await recorder!.flush()
  expect(t.rows.filter(x => x.event === 'long-task')).toHaveLength(0)
 })
 it('accounts keyboard and observer callback counts and elapsed own work per actual window', async () => {
  const t = setup(3); t.clock(100); t.key({ composedPath: () => { t.clock(102); return [t.input] } }); t.task([{ startTime: 101, duration: 60 }]); t.clock(60_000); recorder!.reportAccounting(false); await recorder!.flush()
  expect(t.rows.find(x => x.event === 'callback-accounting')).toMatchObject({ keyCallbacks: 1, taskCallbacks: 1, taskEntries: 1, durationMs: 60_000, partial: false, keyCallbackMs: 2, taskCallbackMs: 3, totalOwnCallbackMs: 5 })
 })
 it('bounds pending histories and writes without recording input content', async () => {
  const t = setup(); for (let i = 0; i < 300; i++) { t.clock(i); t.key() }
  for (let i = 0; i < 100; i++) t.task([{ startTime: 300 + i, duration: 100 }])
  await recorder!.flush(); expect(t.send.mock.calls[0][0].length).toBeLessThanOrEqual(64)
  expect(t.rows.find(x => x.event === 'typing-summary')).toMatchObject({ keysObserved: 300, keyHistoryDropped: 236 })
  expect(t.rows.find(x => x.event === 'suppressed')).toBeDefined()
 })
 it('stops after storage rejection and tears down observers, listeners and timers', async () => {
  const t = setup(); t.send.mockResolvedValueOnce({ accepted: false }); await recorder!.flush(); expect(t.disconnect).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  const n = t.send.mock.calls.length; t.task([{ startTime: 1, duration: 200 }]); await recorder!.flush(); expect(t.send).toHaveBeenCalledTimes(n)
 })
 it('records only the failing entry type when a native reader fails', async () => {
  const t = setup(); t.task([{ get duration() { throw new Error('PRIVATE_ERROR') }, startTime: 0 }]); await recorder!.flush()
  expect(t.rows.find(x => x.event === 'observer-error')).toMatchObject({ observer: 'longtask' }); expect(JSON.stringify(t.rows)).not.toContain('PRIVATE_ERROR')
 })
})
