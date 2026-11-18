import { sanitizeTypingCaptureRecord } from './typing-capture-record'
import { createMainTypingCapture, type TypingCaptureTarget } from './typing-stall-capture'
import { sanitizeTypingDiagnosticRecord, TYPING_DIAGNOSTICS_BATCH } from '../shared/beta-typing-diagnostics'
import { createTypingDiagnosticsFile } from './typing-diagnostics-file'

interface Sender { id: number; getOSProcessId(): number }
interface Host {
  enabled: boolean
  directory(): string
  mainWindowId(): number | undefined
  version?: string
  captureTarget?: () => TypingCaptureTarget | null
  file?: typeof createTypingDiagnosticsFile
}

/** This scope never reaches the ordinary logger, console, feedback tail, or an outbound reporter. */
export function createBetaTypingDiagnosticsHandler(host: Host) {
  let file: ReturnType<typeof createTypingDiagnosticsFile> | null = null
  const capture = host.enabled && host.captureTarget ? createMainTypingCapture({
    contents: host.captureTarget,
    write: async value => {
      const safe = sanitizeTypingCaptureRecord(value)
      // Only this internal closure accepts sampling records. PID was stamped by
      // main before capture.observe and checked against the actual target PID.
      if (!safe || !Number.isSafeInteger(value.rendererPid) || Number(value.rendererPid) <= 0) return false
      file ??= (host.file ?? createTypingDiagnosticsFile)(host.directory())
      const result = await file.append([{ ...safe, schema: 1, appVersion: host.version ?? 'unknown', receivedAt: Date.now(), rendererPid: value.rendererPid }])
      return result.accepted
    },
  }) : null
  return async (sender: Sender, value: unknown): Promise<unknown> => {
    try {
      if (!host.enabled || sender.id !== host.mainWindowId()) return { enabled: false, accepted: false }
      if (!value || typeof value !== 'object') return { accepted: false, reason: 'invalid' }
      const input = value as Record<string, unknown>
      if (input.operation === 'config') return { enabled: !file?.failed }
      if (input.operation !== 'append' || !Array.isArray(input.records) || input.records.length > TYPING_DIAGNOSTICS_BATCH) return { accepted: false, reason: 'invalid' }
      const receivedAt = Date.now(), rendererPid = sender.getOSProcessId()
      const records = input.records.flatMap(value => {
        const record = sanitizeTypingDiagnosticRecord(value)
        return record ? [{ ...record, schema: 1, appVersion: host.version ?? 'unknown', receivedAt, rendererPid }] : []
      })
      if (!records.length) return { accepted: true, records: 0 }
      file ??= (host.file ?? createTypingDiagnosticsFile)(host.directory())
      const result = await file.append(records)
      if (result.accepted) for (const record of records) capture?.observe(sender.id, record)
      else if (result.reason !== 'busy') capture?.stop()
      return result
    } catch { capture?.stop(); return { accepted: false, reason: 'storage' } }
  }
}
