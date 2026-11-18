/** Upload deadlines are shared by every device host; renderer timing only observes this runner. */
export const ATTACHMENT_UPLOAD_TIMEOUT_MS = 120_000
export const ATTACHMENT_UPLOAD_IDLE_MS = 15_000
export const ATTACHMENT_UPLOAD_START_MS = 30_000
export const ATTACHMENT_UPLOAD_RESPONSE_MS = 20_000
// A completed write can still be buffered in the network stack. Allow the request body to drain at 64 KiB/s
// before the response grace period, with the signed plan expiry still capping the attempt.
const ATTACHMENT_UPLOAD_DRAIN_BYTES_PER_SECOND = 64 * 1024
export class AttachmentDeadlineError extends Error {
  constructor(readonly stage: string, message = 'Attachment send timed out') { super(message) }
}
export function linkedAttachmentSignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const listeners = signals.map(signal => {
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    return () => signal.removeEventListener('abort', abort)
  })
  controller.signal.addEventListener('abort', () => { for (const dispose of listeners) dispose() }, { once: true })
  const aborted = signals.find(signal => signal.aborted)
  if (aborted) controller.abort(aborted.reason)
  return controller.signal
}
export type AttachmentStageOperation<T> = (signal: AbortSignal, capDeadline: (expiresAt: string | undefined) => void, progress: (sent?: number, total?: number) => void) => Promise<T>
export async function runAttachmentStage<T>(stage: string, operation: AttachmentStageOperation<T>, parent?: AbortSignal,
  options: { timeoutMs: number | null; timeoutError?: () => Error; watchUpload?: boolean } = { timeoutMs: null }): Promise<T> {
  const controller = new AbortController(), signal = parent ? linkedAttachmentSignal([parent, controller.signal]) : controller.signal
  const watchUpload = stage === 'upload' && options.watchUpload !== false
  let deadline = options.timeoutMs === null ? Infinity : Date.now() + options.timeoutMs
  let uploadDeadline = Date.now() + ATTACHMENT_UPLOAD_START_MS, lastSent = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timeout)
    const next = Math.min(deadline, watchUpload ? uploadDeadline : Infinity)
    if (Number.isFinite(next)) timeout = setTimeout(() => controller.abort(options.timeoutError?.() ?? new AttachmentDeadlineError(stage)), Math.max(0, next - Date.now()))
  }
  const progress = (sent?: number, total?: number) => {
    if (signal.aborted || sent !== undefined && (!Number.isFinite(sent) || sent <= lastSent)) return
    if (sent === undefined) {
      if (lastSent === 0) uploadDeadline = Date.now() + ATTACHMENT_UPLOAD_START_MS
    } else {
      lastSent = sent
      const complete = total !== undefined && Number.isFinite(total) && total > 0 && sent >= total
      uploadDeadline = Date.now() + (complete
        ? ATTACHMENT_UPLOAD_RESPONSE_MS + Math.ceil(total * 1000 / ATTACHMENT_UPLOAD_DRAIN_BYTES_PER_SECOND)
        : ATTACHMENT_UPLOAD_IDLE_MS)
    }
    arm()
  }
  const capDeadline = (expiresAt: string | undefined) => {
    if (!expiresAt) return
    const expiry = Date.parse(expiresAt)
    if (Number.isFinite(expiry)) { deadline = Math.min(deadline, expiry); arm() }
  }
  arm()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([aborted, Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal, capDeadline, progress) })]) }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', onAbort); controller.abort(new Error('Attachment stage finished')) }
}
