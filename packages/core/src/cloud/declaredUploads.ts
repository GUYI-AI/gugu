// The server lists the upload duties; this device's stored bytes are their only local persistence.
import { AttachmentsError, finishDeclaredAttachment, pendingAttachmentUploads, type AttachmentsEndpoint, type AttachmentUploadPlan } from './attachmentsApi'
import { linkedAttachmentSignal, runAttachmentStage, type AttachmentStageOperation } from './attachmentDeadline'

export type AttachmentUploadTask = { messageId: string; chatId: string; as: string; pendingKey: string; sha256: string; name: string; contentType: string; size: number }
export type DeclaredUploadProgress = { sha256: string; chatId?: string; loaded: number; total: number; attempt: number; failed?: boolean; final?: boolean }
export type DeclaredUploadHost = {
  endpoint(): Promise<AttachmentsEndpoint>
  copyOf(sha256: string): Promise<Blob | null>
  attempt?(task: AttachmentUploadTask, attempt: number, run: AttachmentStageOperation<void>): Promise<void>
  progress(messageId: string, progress?: DeclaredUploadProgress): void
  warn?(error: unknown): void
}
const FINISH_WAIT_MS = 120_000, RETRY_FIRST_MS = 5_000, RETRY_MAX_MS = 60_000
export function createDeclaredUploads(host: DeclaredUploadHost) {
  const running = new Map<string, Promise<void>>()
  // False until a late prepare or running upload has observed the cancellation.
  const dropped = new Map<string, boolean>()
  const controllers = new Set<AbortController>()
  const again = new Map<string, { task: AttachmentUploadTask; file: Blob; timer: ReturnType<typeof setTimeout>; delay: number }>()
  let askAgain: { timer: ReturnType<typeof setTimeout>; delay: number } | null = null
  let resuming: Promise<void> | null = null, closed = false
  function begin(task: AttachmentUploadTask, file: Blob, plan: AttachmentUploadPlan | null): Promise<void> {
    if (closed) return Promise.reject(new Error('Attachment upload host stopped'))
    if (dropped.has(task.messageId)) { dropped.set(task.messageId, true); return Promise.resolve() }
    const current = running.get(task.messageId)
    if (current) return current
    const later = again.get(task.messageId)
    if (later) clearTimeout(later.timer)
    const run = upload(task, file, plan).finally(() => { running.delete(task.messageId); if (dropped.has(task.messageId)) dropped.set(task.messageId, true) })
    running.set(task.messageId, run)
    run.catch(() => undefined) // The caller and progress report the error; background retries own the duty.
    return run
  }
  function drop(messageId: string) {
    const later = again.get(messageId)
    if (later) { clearTimeout(later.timer); again.delete(messageId) }
    dropped.set(messageId, running.has(messageId) || !!later)
    host.progress(messageId)
  }
  function retry(messageId: string): Promise<void> {
    const later = again.get(messageId)
    return later ? begin(later.task, later.file, null) : resume()
  }
  function resume(): Promise<void> {
    if (closed) return Promise.resolve()
    return resuming ??= readPending().finally(() => { resuming = null })
  }
  async function readPending() {
    try {
      const uploads = await pendingAttachmentUploads(await host.endpoint())
      const pendingIds = new Set(uploads.map(upload => upload.message_id))
      for (const [id, observed] of dropped) if (observed && !pendingIds.has(id) && !running.has(id)) dropped.delete(id)
      if (askAgain) { clearTimeout(askAgain.timer); askAgain = null }
      for (const pending of uploads) {
        if (closed || running.has(pending.message_id) || dropped.has(pending.message_id)) continue
        const file = await host.copyOf(pending.sha256)
        if (!file || closed || dropped.has(pending.message_id)) continue
        void begin({ messageId: pending.message_id, chatId: pending.chat_id, as: pending.as, pendingKey: pending.staging_key, sha256: pending.sha256,
          name: pending.file_name ?? '', contentType: pending.content_type, size: pending.size_bytes }, file, null)
      }
    } catch (error) {
      if (!closed) {
        const delay = Math.min(askAgain ? askAgain.delay * 2 : RETRY_FIRST_MS, RETRY_MAX_MS)
        if (askAgain) clearTimeout(askAgain.timer)
        askAgain = { delay, timer: setTimeout(() => { void resume().catch(() => undefined) }, delay) }
        host.warn?.(error)
      }
      throw error
    }
  }
  async function upload(task: AttachmentUploadTask, file: Blob, first: AttachmentUploadPlan | null) {
    let progress: DeclaredUploadProgress = { sha256: task.sha256, chatId: task.chatId, loaded: 0, total: task.size, attempt: 1 }
    host.progress(task.messageId, progress)
    let stage: { capDeadline(expiresAt: string | undefined): void; progress(sent?: number, total?: number): void } | null = null
    try {
      const endpoint = await host.endpoint()
      const finished = await finishDeclaredAttachment(endpoint, { staging_key: task.pendingKey, size_bytes: task.size, ...(first ? { plan: first } : {}) },
        { bytes: file, name: task.name, contentType: task.contentType }, { id: task.messageId, chat_id: task.chatId, as: task.as }, {
          attempt: async (attempt, run) => {
            const controller = new AbortController(); controllers.add(controller)
            const operation: AttachmentStageOperation<void> = async (signal, capDeadline, advance) => {
              stage = { capDeadline, progress: advance }
              const joined = linkedAttachmentSignal([signal, controller.signal])
              const fetchImpl: typeof fetch = (input, init) => (endpoint.fetch ?? fetch)(input, { ...init,
                signal: init?.signal ? linkedAttachmentSignal([joined, init.signal]) : joined })
              await run({ ...endpoint, fetch: fetchImpl, ...(endpoint.upload ? { upload: (url, init, report) => endpoint.upload!(url,
                { ...init, signal: init.signal ? linkedAttachmentSignal([joined, init.signal]) : joined }, report) } : {}) }, joined)
            }
            try {
              if (host.attempt) await host.attempt(task, attempt, operation)
              else await runAttachmentStage('upload', operation, controller.signal, { timeoutMs: null })
            } finally { controllers.delete(controller); controller.abort(new Error('Upload attempt ended')) }
          },
          onPlan: plan => { stage?.capDeadline(plan.expires_at); stage?.progress() },
          onProgress: (transfer, attempt) => {
            stage?.progress(transfer.loaded, transfer.total)
            progress = { sha256: task.sha256, chatId: task.chatId, loaded: transfer.loaded, total: transfer.total ?? task.size, attempt }
            host.progress(task.messageId, progress)
          },
          declarationWaitMs: FINISH_WAIT_MS,
          stopped: () => closed || dropped.has(task.messageId),
        })
      if (!finished || closed) return
      again.delete(task.messageId)
      host.progress(task.messageId)
    } catch (error) {
      if (closed || dropped.has(task.messageId)) return
      const final = error instanceof AttachmentsError && error.code === 'upload_mismatch'
      if (!final) {
        const delay = Math.min(again.has(task.messageId) ? again.get(task.messageId)!.delay * 2 : RETRY_FIRST_MS, RETRY_MAX_MS)
        const timer = setTimeout(() => { if (again.get(task.messageId)?.timer === timer) void begin(task, file, null) }, delay)
        again.set(task.messageId, { task, file, timer, delay })
      }
      host.progress(task.messageId, { ...progress, failed: true, final })
      host.warn?.(error)
      throw error
    }
  }
  return { begin, drop, retry, resume, dispose() {
    closed = true
    if (askAgain) clearTimeout(askAgain.timer)
    for (const { timer } of again.values()) clearTimeout(timer)
    for (const controller of controllers) controller.abort(new Error('Attachment upload host stopped'))
    again.clear()
  } }
}
