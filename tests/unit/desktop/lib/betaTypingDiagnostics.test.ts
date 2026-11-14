import { describe, expect, it } from 'vitest'
import { sanitizeTypingDiagnosticRecord, typingDiagnosticsEnabled } from '../../../../apps/desktop/shared/beta-typing-diagnostics'


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
    expect(out).toMatchObject({ durationMs: 55.12, attribution: [{ container: 'unknown', scope: 'self' }], scripts: [{ file: 'assets/main-abc.js', functionName: 'renderGroup', durationMs: 42 }, { file: 'assets/chunk.js', functionName: 'unknown' }] })
    expect(out).not.toHaveProperty('status')
    expect(JSON.stringify(out)).not.toMatch(/PRIVATE_|private input/)
    expect(sanitizeTypingDiagnosticRecord({ event: 'message', content: 'secret' })).toBeNull()
    expect(sanitizeTypingDiagnosticRecord({ event: 'key-latency', durationMs: NaN, startMs: -1 })).toEqual({ event: 'key-latency' })
  })

  it('bounds long-frame metadata and rejects retired sampling payloads', () => {
    const out = sanitizeTypingDiagnosticRecord({ event: 'long-frame', scriptsTotal: 25,
      scripts: Array.from({ length: 25 }, (_, index) => ({ file: 'gugu-app://app/assets/main.js', functionName: 'render', durationMs: index })),
      samples: [{ stack: [{ functionName: 'PRIVATE_STACK_CANARY' }] }], taskSequences: [1], sampleIntervalMs: 500,
    })!
    expect(out.scripts).toHaveLength(12)
    expect(out.scriptsTotal).toBe(25)
    expect(out).not.toHaveProperty('samples')
    expect(out).not.toHaveProperty('taskSequences')
    expect(out).not.toHaveProperty('sampleIntervalMs')
    expect(sanitizeTypingDiagnosticRecord({ event: 'profile', samples: [{ stack: ['PRIVATE_STACK_CANARY'] }] })).toBeNull()
    expect(sanitizeTypingDiagnosticRecord({ event: 'observer-error', observer: 'event', error: 'PRIVATE_ERROR_CANARY' })).toEqual({ event: 'observer-error', observer: 'event' })
    expect(sanitizeTypingDiagnosticRecord({ event: 'observer-error', observer: 'PRIVATE_OBSERVER_CANARY' })).toEqual({ event: 'observer-error' })
  })
})
