import { vi } from 'vitest'
import { H_FIRST_ERROR_PREFIX, H_FIRST_ERROR_SOURCE } from '../../scripts/test-infra/phone-composer-first-error.mjs'

/** Observe the real error without replacing the runtime, suppressing console, or manufacturing a stack. */
export function installPhoneComposerFirstErrorDiagnostic(testName: string) {
  const originalError = console.error.bind(console)
  let first = true
  let phase = 'before-test'
  let lineCount: number | null = null
  let editorText: string | null = null
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    originalError(...args)
    if (!first || String(args[0]) !== 'NotificationManager: subscriber callback error') return
    first = false
    const error = args.find((value): value is Error => value instanceof Error)
    const originalStack = typeof error?.stack === 'string' && error.stack.trim() ? error.stack : null
    console.info(H_FIRST_ERROR_PREFIX + JSON.stringify({
      version: 1, kind: 'phone-composer-first-error', source: H_FIRST_ERROR_SOURCE, testName,
      phase, lineCount, editorText, errorMessage: error?.message ?? args.map(String).join(' | '),
      hasOriginalStack: originalStack !== null, originalStack,
    }))
  })
  return {
    phase(next: string, count: number | null = null, text: string | null = null) {
      phase = next; lineCount = count; editorText = text
      console.info('[H-DIAG-PHASE]', JSON.stringify({ testName, phase, lineCount, editorText }))
    },
    restore() { spy.mockRestore() },
  }
}
