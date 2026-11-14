import { sanitizeTypingDiagnosticRecord, TYPING_DIAGNOSTICS_BATCH } from '../shared/beta-typing-diagnostics'
import { createTypingDiagnosticsFile } from './typing-diagnostics-file'

interface Sender { id: number; getOSProcessId(): number }
interface Host {
  enabled: boolean
  directory(): string
  mainWindowId(): number | undefined
  version?: string
  file?: typeof createTypingDiagnosticsFile
}

/** This scope never reaches the ordinary logger, console, feedback tail, or an outbound reporter. */
export function createBetaTypingDiagnosticsHandler(host: Host) {
  let file: ReturnType<typeof createTypingDiagnosticsFile> | null = null
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
      return await file.append(records)
    } catch { return { accepted: false, reason: 'storage' } }
  }
}

/** Profiling permission only belongs to the Beta application's entry document. */
export function withTypingDiagnosticPolicy(response: Response, requestUrl: string, enabled: boolean): Response {
  if (!enabled) return response
  const url = new URL(requestUrl)
  if (url.protocol !== 'gugu-app:' || url.hostname !== 'app' || url.pathname !== '/index.html') return response
  const headers = new Headers(response.headers)
  const policy = headers.get('Document-Policy')
  if (policy && /(?:^|,)\s*js-profiling(?:\s|=|,|$)/.test(policy)) return response
  headers.set('Document-Policy', [policy, 'js-profiling'].filter(Boolean).join(', '))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
