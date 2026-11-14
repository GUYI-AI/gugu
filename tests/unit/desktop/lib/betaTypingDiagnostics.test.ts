import { describe, expect, it } from 'vitest'
import { sanitizeTypingDiagnosticRecord, typingDiagnosticsEnabled, typingScriptFrame } from '../../../../apps/desktop/shared/beta-typing-diagnostics'
describe('incident trigger metadata boundary', () => {
 it('cannot activate production and accepts the Beta startup switch', () => { expect(typingDiagnosticsEnabled(false, '1')).toBe(false); expect(typingDiagnosticsEnabled(true, '0')).toBe(false); expect(typingDiagnosticsEnabled(true, undefined)).toBe(true) })
 it('retains scalar trigger/accounting data and rejects content or retired continuous observations', () => {
  const value = sanitizeTypingDiagnosticRecord({ event: 'long-task', durationMs: 150.123, typingActive: true, input: 'PRIVATE_INPUT', key: 'PRIVATE_KEY', data: 'PRIVATE_DATA' })
  expect(value).toEqual({ event: 'long-task', durationMs: 150.12, typingActive: true }); expect(JSON.stringify(value)).not.toContain('PRIVATE_')
  for (const event of ['key-latency','long-frame','profile','capture-status']) expect(sanitizeTypingDiagnosticRecord({ event })).toBeNull()
  expect(sanitizeTypingDiagnosticRecord({ event: 'callback-accounting', keyCallbacks: 100, keyCallbackMs: 0.123, totalOwnCallbackMs: Infinity, nodes: ['PRIVATE'] })).toEqual({ event: 'callback-accounting', keyCallbacks: 100, keyCallbackMs: 0.12 })
 })
 it('allows only application frame locations for main-process capture', () => {
  expect(typingScriptFrame({ file: 'gugu-app://app/assets/main.js?PRIVATE_QUERY', functionName: 'render', line: 2 })).toEqual({ file: 'assets/main.js', functionName: 'render', line: 2 })
  expect(typingScriptFrame({ file: 'https://private.invalid/PRIVATE_FILE', functionName: 'PRIVATE_NAME' })).toBeNull()
 })
})
