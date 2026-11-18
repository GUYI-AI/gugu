import { diagnosticSource } from './local-renderer-diagnostics'

declare const __GUGU_TIER__: string | undefined
export const BETA_TYPING_DIAGNOSTICS_BUILD = typeof __GUGU_TIER__ === 'string' && __GUGU_TIER__ === 'beta'
export const TYPING_DIAGNOSTICS_SCOPE = 'beta-typing-diagnostics'
export const TYPING_DIAGNOSTICS_BYTES = 20_000_000
export const TYPING_DIAGNOSTICS_FILES = 5
export const TYPING_DIAGNOSTICS_BATCH = 64
export const TYPING_DIAGNOSTICS_TYPING_WINDOW = 1_000

export function typingDiagnosticsEnabled(betaBuild: boolean, control: string | undefined): boolean {
  return betaBuild && control !== '0'
}

const EVENTS = ['start', 'long-task', 'typing-summary', 'observer-error', 'suppressed', 'callback-accounting'] as const
export type TypingDiagnosticEvent = typeof EVENTS[number]
export type TypingDiagnosticRecord = Record<string, unknown> & { event: TypingDiagnosticEvent }
export interface TypingScriptFrame { file: string; functionName: string; line?: number; column?: number }
const NUMBERS = ['timeOrigin', 'sequence', 'startMs', 'durationMs', 'typingWindowMs', 'recordsDropped', 'keysObserved', 'keyHistoryDropped', 'keyCallbacks', 'taskCallbacks', 'taskEntries', 'keyCallbackMs', 'taskCallbackMs', 'flushCallbacks', 'flushCallbackMs', 'accountingCallbacks', 'accountingCallbackMs', 'totalOwnCallbackMs'] as const
const BOOLEANS = ['typingActive', 'typingOverlap', 'typingContextComplete', 'longTaskSupported', 'visible', 'partial'] as const
const OBSERVERS = ['longtask']
const CONTAINERS = ['window', 'iframe', 'embed', 'object']
const SCOPES = ['self', 'unknown', 'same-origin-descendant', 'cross-origin-descendant', 'same-origin-ancestor', 'cross-origin-ancestor', 'multiple-contexts']
const number = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER
const rounded = (n: number) => Math.round(n * 100) / 100
const object = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null
const stringIn = (value: unknown, allowed: readonly string[]): value is string => typeof value === 'string' && allowed.includes(value)

/** No arbitrary stack strings, remote URLs, selectors, or function arguments cross this boundary. */
export function typingScriptFrame(value: unknown): TypingScriptFrame | null {
  const item = object(value)
  if (!item) return null
  const file = diagnosticSource(item.file)
  if (file === 'unknown') return null
  const name = item.functionName
  const functionName = typeof name === 'string' && /^(?:(?:get|set|bound) )?[A-Za-z_$][A-Za-z0-9_$.<>[\]-]{0,119}$/.test(name) ? name : 'unknown'
  const out: TypingScriptFrame = { file, functionName }
  for (const key of ['line', 'column'] as const) if (Number.isSafeInteger(item[key]) && number(item[key]) && item[key] <= 100_000_000) out[key] = item[key]
  return out
}

/** Applied before IPC and again before disk. Unknown fields are never copied or stringified. */
export function sanitizeTypingDiagnosticRecord(value: unknown): TypingDiagnosticRecord | null {
  const input = object(value)
  if (!input || !EVENTS.includes(input.event as TypingDiagnosticEvent)) return null
  const out: TypingDiagnosticRecord = { event: input.event as TypingDiagnosticEvent }
  for (const key of NUMBERS) if (number(input[key])) out[key] = rounded(input[key])
  for (const key of BOOLEANS) if (typeof input[key] === 'boolean') out[key] = input[key]
  if (typeof input.pageId === 'string' && /^[a-f0-9-]{36}$/.test(input.pageId)) out.pageId = input.pageId
  if (stringIn(input.observer, OBSERVERS)) out.observer = input.observer
  if (Array.isArray(input.attribution)) out.attribution = input.attribution.slice(0, 4).map(value => {
    const entry = object(value)
    return { container: stringIn(entry?.container, CONTAINERS) ? entry!.container : 'unknown', scope: stringIn(entry?.scope, SCOPES) ? entry!.scope : 'unknown' }
  })
  return out
}
