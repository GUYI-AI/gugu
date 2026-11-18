import { rendererLogger } from './log'
import { i18n } from '../i18n'
import type { AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { xhrAttachmentUpload } from './attachmentUploadTransport'
import { ATTACHMENT_UPLOAD_TIMEOUT_MS, AttachmentDeadlineError, linkedAttachmentSignal, runAttachmentStage } from '@gugu/core/cloud/attachmentDeadline'
export { ATTACHMENT_UPLOAD_IDLE_MS, ATTACHMENT_UPLOAD_START_MS, ATTACHMENT_UPLOAD_RESPONSE_MS, linkedAttachmentSignal } from '@gugu/core/cloud/attachmentDeadline'

export const ATTACHMENT_SEND_DEADLINES = { prepare: 120_000, upload: ATTACHMENT_UPLOAD_TIMEOUT_MS, commit: 20_000, readback: 5_000 }
export type AttachmentSendStage = keyof typeof ATTACHMENT_SEND_DEADLINES
const log = rendererLogger('chat/attachments')
export class AttachmentStageTimeout extends AttachmentDeadlineError {
  constructor(readonly stage: AttachmentSendStage) { super(stage, i18n.t('composer.attachmentSendTimedOut', { ns: 'messaging' })) }
}

/** Like chatSendTiming: correlated IDs and elapsed time only, never file contents, URLs or tokens. */
export function attachmentUploadTimeoutMs(sizeBytes: number): number {
  // Reserve two minutes for setup, then allow an 8 KiB/s uplink. The signed
  // upload plan caps this allowance at its actual expiry once it arrives.
  return ATTACHMENT_SEND_DEADLINES.upload + Math.ceil(sizeBytes / 8192 * 1000)
}
/** An endpoint whose requests (and uploads) stop with this attempt's signal. */
export function attachmentAttemptEndpoint(endpoint: AttachmentsEndpoint, signal: AbortSignal): AttachmentsEndpoint {
  return { ...endpoint, fetch: (input, init) => (endpoint.fetch ?? fetch)(input, {
    ...init, signal: init?.signal ? linkedAttachmentSignal([signal, init.signal]) : signal,
  }), upload: (url, init, progress) => (endpoint.upload ?? xhrAttachmentUpload)(url, {
    ...init, signal: init.signal ? linkedAttachmentSignal([signal, init.signal]) : signal,
  }, progress) }
}
export function attachmentSendTiming(clientId: string, chatId: string) {
  const submitted = performance.now()
  return {
    clientId,
    async stage<T>(stage: AttachmentSendStage, attempt: number, operation: (signal: AbortSignal, capDeadline: (expiresAt: string | undefined) => void, progress: (sent?: number, total?: number) => void) => Promise<T>, parent?: AbortSignal, options?: { timeoutMs?: number | null; logResult?: (result: T) => boolean }): Promise<T> {
      const started = performance.now()
      const fields = { clientId, chatId, stage, attempt }
      try {
        const result = await runAttachmentStage(stage, operation, parent, { timeoutMs: options?.timeoutMs === undefined ? ATTACHMENT_SEND_DEADLINES[stage] : options.timeoutMs, timeoutError: () => new AttachmentStageTimeout(stage) })
        const elapsedMs = Math.round(performance.now() - started)
        if (options?.logResult?.(result) !== false) log[elapsedMs > 2000 ? 'warn' : 'info']({ ...fields, elapsedMs, outcome: 'success' }, 'attachment send stage timing')
        return result
      } catch (error) {
        log[parent?.aborted && !(error instanceof AttachmentStageTimeout) ? 'info' : 'warn']({ ...fields, elapsedMs: Math.round(performance.now() - started), outcome: error instanceof AttachmentStageTimeout ? 'timeout' : parent?.aborted ? 'cancelled' : 'failed' }, 'attachment send stage timing')
        throw error
      }
    },
    finish(outcome: 'success' | 'failed' | 'unknown', source?: string) {
      const totalMs = Math.round(performance.now() - submitted)
      log[outcome === 'failed' || totalMs > 2000 ? 'warn' : 'info']({ clientId, chatId, totalMs, outcome, source }, 'attachment send timing')
    },
  }
}
export type AttachmentSendTiming = ReturnType<typeof attachmentSendTiming>
