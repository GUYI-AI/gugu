// The server lists the upload duties and their original keys; this device keeps the bytes and caches the live plan.
import { AttachmentsError, declaredUploadState, finishDeclaredAttachment, pendingAttachmentUploads, type AttachmentsEndpoint, type AttachmentUploadPlan, type DeclaredUploadState } from './attachmentsApi'

export type AttachmentUploadTask = { messageId: string; chatId: string; as: string; pendingKey: string; sha256: string; name: string; contentType: string; size: number }
export type DeclaredUploadProgress = { sha256: string; chatId?: string; loaded: number; total: number; attempt: number; failed?: boolean; final?: boolean; reason?: string }
export type DeclaredUploadHost = {
  endpoint(): Promise<AttachmentsEndpoint>
  copyOf(sha256: string): Promise<Blob | null>
  progress(messageId: string, progress?: DeclaredUploadProgress): void
  warn?(error: unknown): void
}
const FINISH_WAIT_MS = 120_000, RETRY_FIRST_MS = 5_000, RETRY_MAX_MS = 60_000
export function createDeclaredUploads(host: DeclaredUploadHost) {
  const running = new Map<string, Promise<void>>()
  const permits = new Map<string, { pendingKey: string; upload: DeclaredUploadState }>()
  // False until a late prepare or running upload has observed the cancellation.
  const dropped = new Map<string, boolean>()
  const controllers = new Set<AbortController>()
  let askAgain: { timer: ReturnType<typeof setTimeout>; delay: number } | null = null
  let resuming: Promise<void> | null = null, closed = false
  function begin(task: AttachmentUploadTask, file: Blob, plan: AttachmentUploadPlan | null): Promise<void> {
    if (closed) return Promise.reject(new Error('Attachment upload host stopped'))
    if (dropped.has(task.messageId)) { dropped.set(task.messageId, true); return Promise.resolve() }
    const current = running.get(task.messageId)
    if (current) return current
    const run = upload(task, file, plan).finally(() => { running.delete(task.messageId); if (dropped.has(task.messageId)) dropped.set(task.messageId, true) })
    running.set(task.messageId, run)
    run.catch(() => undefined) // The caller and progress report the error; the server retains the pending duty.
    return run
  }
  function drop(messageId: string) {
    dropped.set(messageId, running.has(messageId))
    permits.delete(messageId)
    host.progress(messageId)
  }
  function resume(): Promise<void> {
    if (closed) return Promise.resolve()
    return resuming ??= readPending().finally(() => { resuming = null })
  }
  async function readPending(messageId?: string) {
    if (closed) return
    try {
      const uploads = await pendingAttachmentUploads(await host.endpoint())
      const pendingIds = new Set(uploads.map(upload => upload.message_id))
      for (const [id, observed] of dropped) if (observed && !pendingIds.has(id) && !running.has(id)) dropped.delete(id)
      for (const id of permits.keys()) if (!pendingIds.has(id) && !running.has(id)) permits.delete(id)
      if (askAgain) { clearTimeout(askAgain.timer); askAgain = null }
      for (const pending of uploads) {
        if (messageId && pending.message_id !== messageId) continue
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
    const controller = new AbortController()
    controllers.add(controller)
    const cached = permits.get(task.messageId)
    const upload = cached?.pendingKey === task.pendingKey ? cached.upload : declaredUploadState(task.pendingKey, task.messageId, first ?? undefined)
    permits.set(task.messageId, { pendingKey: task.pendingKey, upload })
    try {
      const endpoint = await host.endpoint()
      const finished = await finishDeclaredAttachment(endpoint, { staging_key: task.pendingKey, size_bytes: task.size, ...(first ? { plan: first } : {}) },
        { bytes: file.slice(0, file.size, task.contentType), name: task.name, contentType: task.contentType }, { id: task.messageId, chat_id: task.chatId, as: task.as }, {
          signal: controller.signal,
          upload,
          onProgress: (transfer, attempt) => {
            progress = { sha256: task.sha256, chatId: task.chatId, loaded: transfer.loaded, total: transfer.total ?? task.size, attempt }
            host.progress(task.messageId, progress)
          },
          declarationWaitMs: FINISH_WAIT_MS,
          stopped: () => closed || dropped.has(task.messageId),
        })
      if (!finished || closed) return
      permits.delete(task.messageId)
      host.progress(task.messageId)
    } catch (error) {
      if (closed || dropped.has(task.messageId)) return
      if (error instanceof AttachmentsError && error.code === 'upload_not_found') {
        const pending = await host.endpoint().then(pendingAttachmentUploads).catch(pendingError => {
          host.warn?.(pendingError); return null // A failed read cannot release the upload duty.
        })
        if (closed || dropped.has(task.messageId)) return
        if (pending && !pending.some(upload => upload.message_id === task.messageId)) {
          permits.delete(task.messageId)
          host.progress(task.messageId)
          return
        }
      }
      const final = error instanceof AttachmentsError && (error.code === 'upload_mismatch' || error.code === 'too_large' || error.status === 413)
      const reason = error instanceof AttachmentsError && error.status === 429 && error.code.endsWith('_full') ? error.reason : undefined
      if (final) permits.delete(task.messageId)
      host.progress(task.messageId, { ...progress, failed: true, final, reason })
      host.warn?.(error)
      throw error
    } finally { controllers.delete(controller) }
  }
  return { begin, drop, retry: (messageId: string) => resuming ?? readPending(messageId), resume, dispose() {
    closed = true
    permits.clear()
    if (askAgain) clearTimeout(askAgain.timer)
    for (const controller of controllers) controller.abort(new Error('Attachment upload host stopped'))
  } }
}
