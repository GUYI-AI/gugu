import { rendererLogger } from './log'
import { i18n } from '../i18n'
import type { AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { xhrAttachmentUpload } from './attachmentUploadTransport'
import { AttachmentDeadlineError, linkedAttachmentSignal, runAttachmentStage, type AttachmentStageOperation } from '@gugu/core/cloud/attachmentDeadline'
export { linkedAttachmentSignal } from '@gugu/core/cloud/attachmentDeadline'

export const ATTACHMENT_SEND_DEADLINES = { prepare: 120_000, commit: 20_000, readback: 5_000 }
export type AttachmentSendStage = keyof typeof ATTACHMENT_SEND_DEADLINES
const log = rendererLogger('chat/attachments')
export class AttachmentStageTimeout extends AttachmentDeadlineError {
  constructor(readonly stage: AttachmentSendStage) { super(stage, i18n.t('composer.attachmentSendTimedOut', { ns: 'messaging' })) }
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
    async stage<T>(stage: AttachmentSendStage, attempt: number, operation: AttachmentStageOperation<T>, parent?: AbortSignal, options?: { timeoutMs?: number | null; logResult?: (result: T) => boolean }): Promise<T> {
      const started = performance.now()
      const fields = { clientId, chatId, stage, attempt }
      try {
        const result = await runAttachmentStage(stage, operation, parent, { timeoutMs: options?.timeoutMs === undefined ? ATTACHMENT_SEND_DEADLINES[stage] : options.timeoutMs, timeoutError: () => new AttachmentStageTimeout(stage) })
        const elapsedMs = Math.round(performance.now() - started)
        if (options?.logResult?.(result) !== false) log[elapsedMs > 2000 ? 'warn' : 'info']({ ...fields, elapsedMs, outcome: 'success' }, 'attachment send stage timing')
        return result
      } catch (error) {
        const failure = error instanceof AttachmentDeadlineError && !(error instanceof AttachmentStageTimeout) ? new AttachmentStageTimeout(stage) : error
        log[parent?.aborted && !(failure instanceof AttachmentStageTimeout) ? 'info' : 'warn']({ ...fields, elapsedMs: Math.round(performance.now() - started), outcome: failure instanceof AttachmentStageTimeout ? 'timeout' : parent?.aborted ? 'cancelled' : 'failed' }, 'attachment send stage timing')
        throw failure
      }
    },
    finish(outcome: 'success' | 'failed' | 'unknown', source?: string) {
      const totalMs = Math.round(performance.now() - submitted)
      log[outcome === 'failed' || totalMs > 2000 ? 'warn' : 'info']({ clientId, chatId, totalMs, outcome, source }, 'attachment send timing')
    },
  }
}
export type AttachmentSendTiming = ReturnType<typeof attachmentSendTiming>
