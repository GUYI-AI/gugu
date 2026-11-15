import { typingScriptFrame } from '../shared/beta-typing-diagnostics'
import type { TypingCaptureRecord } from './typing-stall-capture'

const NUMBERS = ['timeOrigin', 'durationMs', 'capture', 'triggerSequence', 'requestAt', 'captureStartAt', 'captureEndAt', 'sampleIntervalMs', 'profileDurationMs', 'setupDurationMs', 'totalSamples', 'samplesOmitted', 'clockUncertaintyMs', 'profileSpanMs', 'effectiveIntervalMedianMs'] as const
const STATUS = ['started', 'complete', 'skipped', 'interrupted']
const REASONS = ['occupied', 'attach-unavailable', 'target-unavailable', 'detached', 'protocol-error', 'storage', 'invalid-profile']
const object = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null
const number = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= Number.MAX_SAFE_INTEGER
const rounded = (x: number) => Math.round(x * 100) / 100

/** Main-only boundary: the renderer's existing sanitizer rejects these events. */
export function sanitizeTypingCaptureRecord(value: unknown): TypingCaptureRecord | null {
  const input = object(value)
  if (!input || input.event !== 'profile' && input.event !== 'capture-status') return null
  const out: TypingCaptureRecord = { event: input.event }
  for (const key of NUMBERS) if (number(input[key])) out[key] = rounded(input[key])
  if (typeof input.pageId === 'string' && /^[a-f0-9-]{36}$/.test(input.pageId)) out.pageId = input.pageId
  if (typeof input.status === 'string' && STATUS.includes(input.status)) out.status = input.status
  if (typeof input.reason === 'string' && REASONS.includes(input.reason)) out.reason = input.reason
  if (input.event === 'profile' && Array.isArray(input.samples)) out.samples = input.samples.slice(0, 8).flatMap(value => {
    const sample = object(value)
    if (!sample || !number(sample.offsetMs) || !Array.isArray(sample.stack)) return []
    return [{ offsetMs: rounded(sample.offsetMs), ...(typeof sample.stackTruncated === 'boolean' ? { stackTruncated: sample.stackTruncated } : {}), stack: sample.stack.slice(0, 12).flatMap(value => { const frame = typingScriptFrame(value); return frame ? [frame] : [] }) }]
  })
  return out
}
