import { serverNow } from '../shared/serverClock'

/** Upload writes use the same inactivity window on every device host. */
// Chromium and fetch do not expose a socket idle event. Allow a minute between observed writes,
// on the scale of HTTP socket idle timeouts, without imposing a throughput or response deadline.
export const ATTACHMENT_UPLOAD_IDLE_MS = 60_000
export class AttachmentDeadlineError extends Error {
  constructor(readonly stage: string, message = 'Attachment send timed out') { super(message) }
}
export function waitForAttachmentRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve() }, ms)
    signal?.addEventListener('abort', aborted, { once: true })
  })
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
export type AttachmentStageOperation<T> = (signal: AbortSignal, capDeadline: (expiresAt: string | undefined) => void, progress: (sent: number, total?: number) => void) => Promise<T>
export async function runAttachmentStage<T>(stage: string, operation: AttachmentStageOperation<T>, parent?: AbortSignal,
  options: { timeoutMs: number | null; timeoutError?: () => Error; watchUpload?: boolean } = { timeoutMs: null }): Promise<T> {
  const controller = new AbortController(), signal = parent ? linkedAttachmentSignal([parent, controller.signal]) : controller.signal
  let deadline = options.timeoutMs === null ? Infinity : Date.now() + options.timeoutMs
  let idleDeadline = options.watchUpload ? Date.now() + ATTACHMENT_UPLOAD_IDLE_MS : Infinity
  let lastSent = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timeout)
    const next = Math.min(deadline, idleDeadline)
    if (Number.isFinite(next)) timeout = setTimeout(() => {
      if (next > Date.now()) arm()
      else controller.abort(options.timeoutError?.() ?? new AttachmentDeadlineError(stage))
    }, Math.min(2 ** 31 - 1, Math.max(0, next - Date.now())))
  }
  const progress = (sent: number, total?: number) => {
    if (signal.aborted || !Number.isFinite(idleDeadline) || !Number.isFinite(sent) || sent <= lastSent) return
    lastSent = sent
    idleDeadline = total !== undefined && total > 0 && sent >= total ? Infinity : Date.now() + ATTACHMENT_UPLOAD_IDLE_MS
    arm()
  }
  const capDeadline = (expiresAt: string | undefined) => {
    if (!expiresAt) return
    // The permit's expiry is on the backend's clock; `deadline` is on this device's (`@@@server-clock`).
    const expiry = Date.parse(expiresAt) - serverNow() + Date.now()
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
