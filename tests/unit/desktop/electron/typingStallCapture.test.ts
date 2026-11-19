import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cdpTypingSamples, createMainTypingCapture } from '../../../../apps/desktop/electron/typing-stall-capture'
import type { TypingCaptureRecord } from '../../../../apps/desktop/electron/typing-stall-capture'
import { sanitizeTypingCaptureRecord } from '../../../../apps/desktop/electron/typing-capture-record'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function setup(options: { devtools?: boolean; attached?: boolean; fail?: string; hang?: string; attachError?: boolean; writable?: boolean } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T08:00:00Z'))
  const rows: TypingCaptureRecord[] = [], events = new EventEmitter()
  let attached = options.attached ?? false
  const port = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => { if (attached || options.attachError) throw new Error('PRIVATE_OCCUPIED'); attached = true }),
    detach: vi.fn(() => { attached = false; events.emit('detach', {}, 'test') }),
    on: (name: 'detach', listener: (event: unknown, reason: string) => void) => events.on(name, listener),
    removeListener: (name: 'detach', listener: (event: unknown, reason: string) => void) => events.removeListener(name, listener),
    sendCommand: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === options.fail) throw new Error('PRIVATE_PROTOCOL_ERROR')
      if (method === options.hang) return new Promise(() => {})
      return method === 'Profiler.stop' ? { profile: { nodes: [], samples: [], timeDeltas: [] } } : {}
    }),
  }
  const target = { id: 1, getOSProcessId: () => 1234, isDestroyed: () => false, getURL: () => 'gugu-app://app/index.html', isDevToolsOpened: () => options.devtools ?? false, debugger: port }
  const contents = vi.fn(() => target), write = vi.fn(async (record: TypingCaptureRecord) => { rows.push(record); return options.writable ?? true })
  const capture = createMainTypingCapture({ contents, write, mono: Date.now, wall: Date.now })
  const incident = (fields: Record<string, unknown> = {}) => capture.observe(1, { event: 'long-task', rendererPid: 1234, pageId: '12345678-1234-1234-1234-123456789abc', timeOrigin: Date.now() - 1_000, startMs: 800, durationMs: 150, sequence: 1, typingActive: true, ...fields })
  return { capture, contents, write, incident, port, rows, autoDetach() { attached = false; events.emit('detach', {}, 'PRIVATE_DETACH_REASON') }, externalAttach() { attached = true } }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

describe('main-process incident CPU capture', () => {
  it('does not inspect or attach a debugger while idle or below the typing incident threshold', async () => {
    const t = setup()
    t.incident({ durationMs: 99 }); t.incident({ typingActive: false })
    await settle()
    expect(t.contents).not.toHaveBeenCalled(); expect(t.port.attach).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
    t.capture.stop()
  })

  it('captures only thirty seconds at 100ms, then disables and disconnects its own session', async () => {
    const t = setup(); t.incident(); await settle()
    expect(t.port.sendCommand.mock.calls.map(x => x[0])).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start'])
    expect(t.port.sendCommand).toHaveBeenCalledWith('Profiler.setSamplingInterval', { interval: 100_000 })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(t.port.detach).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.port.sendCommand.mock.calls.map(x => x[0])).toContain('Profiler.stop')
    expect(t.port.sendCommand.mock.calls.map(x => x[0])).toContain('Profiler.disable')
    expect(t.port.detach).toHaveBeenCalledOnce(); expect(t.port.isAttached()).toBe(false)
    expect(t.rows.filter(row => row.event === 'capture-status').map(x => x.status)).toEqual(['started', 'complete'])
    await vi.advanceTimersByTimeAsync(1_100); t.capture.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not take over DevTools or another attached client', async () => {
    for (const options of [{ devtools: true }, { attached: true }]) {
      const t = setup(options); t.incident(); await settle()
      expect(t.port.attach).not.toHaveBeenCalled(); expect(t.port.sendCommand).not.toHaveBeenCalled(); expect(t.port.detach).not.toHaveBeenCalled()
      expect(t.rows).toMatchObject([{ event: 'capture-status', status: 'skipped', reason: 'occupied' }]); t.capture.stop()
    }
  })

  it('records a failed native attach without taking or releasing any connection', async () => {
    const t = setup({ attachError: true }); t.incident(); await settle()
    expect(t.port.sendCommand).not.toHaveBeenCalled(); expect(t.port.detach).not.toHaveBeenCalled()
    expect(t.rows).toMatchObject([{ status: 'skipped', reason: 'attach-unavailable' }]); t.capture.stop()
  })

  it('revokes ownership on native detach and never detaches a replacement connection', async () => {
    const t = setup(); t.incident(); await settle(); t.autoDetach(); await settle()
    t.externalAttach(); t.capture.stop(); await settle()
    expect(t.port.detach).not.toHaveBeenCalled()
    expect(t.rows.at(-1)).toMatchObject({ event: 'capture-status', status: 'interrupted', reason: 'detached' })
    expect(JSON.stringify(t.rows)).not.toContain('PRIVATE_')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('enforces a five-minute post-capture cooldown and six-attempt launch budget across pages', async () => {
    const t = setup()
    for (let i = 0; i < 6; i++) {
      t.incident({ sequence: i + 1 }); await settle()
      expect(t.port.attach).toHaveBeenCalledTimes(i + 1)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(299_999)
      t.incident({ pageId: 'abcdabcd-abcd-abcd-abcd-abcdabcdabcd' }); await settle()
      expect(t.port.attach).toHaveBeenCalledTimes(i + 1)
      await vi.advanceTimersByTimeAsync(1)
    }
    t.incident(); await settle(); expect(t.port.attach).toHaveBeenCalledTimes(6)
    t.capture.stop(); expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up protocol failures and timeout without recording error text', async () => {
    for (const options of [{ fail: 'Profiler.start' }, { hang: 'Profiler.start' }]) {
      const t = setup(options); t.incident(); await settle(); await vi.advanceTimersByTimeAsync(1_000); await settle()
      expect(t.port.detach).toHaveBeenCalledOnce()
      expect(t.rows.at(-1)).toMatchObject({ event: 'capture-status', status: 'interrupted', reason: 'protocol-error' })
      expect(JSON.stringify(t.rows)).not.toContain('PRIVATE_'); t.capture.stop()
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('disconnects if its local sink is unavailable', async () => {
    const t = setup({ writable: false }); t.incident(); await settle()
    expect(t.port.detach).toHaveBeenCalledOnce(); expect(t.write).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
    t.capture.stop()
  })
})

describe('bounded CDP stack metadata', () => {
  it('admits only bounded main-generated metadata, never raw profile nodes or content', () => {
    const result = sanitizeTypingCaptureRecord({ event: 'profile', rendererPid: 999, message: 'PRIVATE_BODY', nodes: ['PRIVATE_NODE'], status: Object('started'), reason: 'PRIVATE_REASON', samples: Array.from({ length: 20 }, () => ({ offsetMs: 1, text: 'PRIVATE_INPUT', stack: Array.from({ length: 20 }, () => ({ file: 'gugu-app://app/assets/main.js?PRIVATE_QUERY', functionName: 'render' })) })) })!
    expect(result.samples).toHaveLength(8)
    expect((result.samples as Array<{ stack: unknown[] }>)[0].stack).toHaveLength(12)
    expect(result).not.toHaveProperty('rendererPid'); expect(JSON.stringify(result)).not.toContain('PRIVATE_')
    expect(sanitizeTypingCaptureRecord({ event: 'long-task' })).toBeNull()
  })

  it('keeps application files near tasks, rejects private URLs, and terminates cycles', () => {
    const profile = { nodes: [{ id: 1, callFrame: { url: 'gugu-app://app/assets/main.js?PRIVATE_QUERY', functionName: 'render', lineNumber: 1, columnNumber: 2 }, children: [2] }, { id: 2, callFrame: { url: 'https://private.invalid/PRIVATE_FILE', functionName: 'PRIVATE_FUNCTION' }, children: [1] }], samples: Array(20).fill(2), timeDeltas: Array(20).fill(100_000) }
    expect(cdpTypingSamples({ ...profile, timeDeltas: [NaN] }, [], 1_000, 1_004)).toBeNull()
    const signed = cdpTypingSamples({ ...profile, samples: [2, 2], timeDeltas: [-1, 100_001] }, [{ sequence: 1, wallStartMs: 1_000, durationMs: 3_000 }], 1_000, 1_004)!
    expect(signed.samples.map(x => x.offsetMs)).toEqual([100])
    const result = cdpTypingSamples(profile, [{ sequence: 1, wallStartMs: 1_000, durationMs: 3_000 }], 1_000, 1_004)!
    expect(result.samples).toHaveLength(8); expect(result.samplesOmitted).toBe(12); expect(result.clockUncertaintyMs).toBe(4)
    expect(result.samples[0].stack).toEqual([{ file: 'assets/main.js', functionName: 'render', line: 2, column: 3 }])
    expect(result.samples[0].stackTruncated).toBe(true); expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })
})
