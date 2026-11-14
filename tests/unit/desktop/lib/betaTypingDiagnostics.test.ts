import { afterEach, describe, expect, it, vi } from 'vitest'
import { sanitizeTypingDiagnosticRecord, typingDiagnosticsEnabled } from '../../../../apps/desktop/shared/beta-typing-diagnostics'
import { createTypingProfiler, profileNearTypingTasks, type TypingProfileTrace } from '../../../../apps/desktop/src/lib/typing-diagnostics-profile'

afterEach(() => { vi.useRealTimers() })

describe('Beta typing diagnostic metadata', () => {
  it('cannot enable a production build with the runtime control', () => {
    expect(typingDiagnosticsEnabled(false, '1')).toBe(false)
    expect(typingDiagnosticsEnabled(false, undefined)).toBe(false)
    expect(typingDiagnosticsEnabled(true, undefined)).toBe(true)
    expect(typingDiagnosticsEnabled(true, '0')).toBe(false)
  })

  it('keeps source metadata while rejecting content, URL queries and boxed enum objects', () => {
    const out = sanitizeTypingDiagnosticRecord({ event: 'long-frame', durationMs: 55.1234,
      message: 'PRIVATE_MESSAGE_CANARY', key: 'PRIVATE_KEY_CANARY', target: { value: 'PRIVATE_VALUE_CANARY' },
      status: Object.assign(Object('enabled'), { secret: 'PRIVATE_BOXED_CANARY' }),
      attribution: [{ container: Object.assign(Object('window'), { secret: 'PRIVATE_CONTAINER_CANARY' }), scope: 'self', containerName: 'PRIVATE_NAME_CANARY' }],
      scripts: [{ file: 'gugu-app://app/assets/main-abc.js?PRIVATE_QUERY_CANARY#PRIVATE_FRAGMENT_CANARY', functionName: 'renderGroup', durationMs: 42, rawInput: 'PRIVATE_INPUT_CANARY' },
        { file: 'https://external.invalid/PRIVATE_URL_CANARY.js', functionName: 'PRIVATE_FUNCTION_CANARY' },
        { file: 'gugu-app://app/assets/chunk.js', functionName: 'private input sentence' }],
      samples: [{ timestampMs: 12, marker: Object.assign(Object('script'), { secret: 'PRIVATE_MARKER_CANARY' }), stack: [{ file: 'file:///Users/person/PRIVATE_PATH_CANARY.js', functionName: 'secret' }] }],
    })!
    expect(out).toMatchObject({ durationMs: 55.12, attribution: [{ container: 'unknown', scope: 'self' }], scripts: [{ file: 'assets/main-abc.js', functionName: 'renderGroup', durationMs: 42 }, { file: 'assets/chunk.js', functionName: 'unknown' }], samples: [{ timestampMs: 12, stack: [] }] })
    expect(out).not.toHaveProperty('status')
    expect(JSON.stringify(out)).not.toMatch(/PRIVATE_|private input/)
    expect(sanitizeTypingDiagnosticRecord({ event: 'message', content: 'secret' })).toBeNull()
    expect(sanitizeTypingDiagnosticRecord({ event: 'key-latency', durationMs: NaN, startMs: -1 })).toEqual({ event: 'key-latency' })
  })

  it('retains frame/stack/resource index zero and only samples near reported tasks', () => {
    const trace: TypingProfileTrace = { resources: ['gugu-app://app/assets/main.js?private=yes'], frames: [{ resourceId: 0, name: 'busyTask', line: 4, column: 8 }], stacks: [{ frameId: 0 }], samples: [{ timestamp: 100, stackId: 0 }, { timestamp: 10_000, stackId: 0 }] }
    const record = sanitizeTypingDiagnosticRecord(profileNearTypingTasks(trace, [{ sequence: 0, startMs: 90, durationMs: 60 }]))!
    expect(record).toMatchObject({ event: 'profile', totalSamples: 2, samplesOmitted: 0, taskSequences: [0], samples: [{ timestampMs: 100, stack: [{ file: 'assets/main.js', functionName: 'busyTask', line: 4, column: 8 }] }] })
    expect(JSON.stringify(record)).not.toContain('private')
    expect(profileNearTypingTasks(trace, [])).toBeNull()
  })

  it('bounds trie cycles and nearby sample output with an explicit omitted count', () => {
    const trace: TypingProfileTrace = { resources: ['https://external.invalid/secret.js'], frames: [{ resourceId: 0, name: 'secret' }], stacks: [{ frameId: 0, parentId: 0 }], samples: Array.from({ length: 24 }, (_, i) => ({ timestamp: 100 + i, stackId: 0 })) }
    const record = profileNearTypingTasks(trace, [{ sequence: 1, startMs: 80, durationMs: 100 }])!
    expect(record.samplesOmitted).toBe(16)
    expect(record.samples).toHaveLength(8)
    expect(JSON.stringify(record)).not.toContain('secret')
  })

  it('stops an allocated sampler if a partial browser API fails during setup', async () => {
    vi.useFakeTimers()
    const stopped = vi.fn(async () => ({ resources: [], frames: [], stacks: [], samples: [] }))
    class PartialProfiler extends EventTarget {
      sampleInterval = 100
      addEventListener() { throw new Error('PRIVATE_BROWSER_ERROR') }
      stop = stopped
    }
    const records: object[] = []
    const profiler = createTypingProfiler({ Profiler: PartialProfiler } as unknown as Window & typeof globalThis, () => [], record => records.push(record))
    await Promise.resolve()
    expect(stopped).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(records).toEqual([{ event: 'profile-status', status: 'failed' }])
    profiler.stop()
    expect(stopped).toHaveBeenCalledOnce()
  })
})
