// The server lists the upload duties; this device's stored bytes are their only local persistence.
import { AttachmentsError, finishDeclaredAttachment, pendingAttachmentUploads, retryableAttachmentError, type AttachmentsEndpoint, type AttachmentUploadPlan } from './attachmentsApi'

export type AttachmentUploadTask = { messageId: string; chatId: string; as: string; pendingKey: string; sha256: string; name: string; contentType: string; size: number }
export type DeclaredUploadProgress = { sha256: string; chatId?: string; loaded: number; total: number; attempt: number; failed?: boolean; final?: boolean }
export type DeclaredUploadHost = {
  endpoint(): Promise<AttachmentsEndpoint>
  copyOf(sha256: string): Promise<Blob | null>
  progress(messageId: string, progress?: DeclaredUploadProgress): void
  warn?(error: unknown): void
}
const FINISH_WAIT_MS = 120_000, RETRY_FIRST_MS = 5_000, RETRY_MAX_MS = 60_000
export function createDeclaredUploads(host: DeclaredUploadHost) {
  const running = new Map<string, Promise<void>>()
  // False until a late prepare or running upload has observed the cancellation.
  const dropped = new Map<string, boolean>()
  const controllers = new Set<AbortController>()
  const authWaiting = new Set<string>(), wakeAfterRun = new Set<string>()
  const retrying = new Set<string>(), terminal = new Set<string>(), requested = new Set<string>()
  let askAgain: ReturnType<typeof setTimeout> | null = null, retryDelay = 0, allRequested = false
  let resuming: Promise<void> | null = null, closed = false
  function clearRetry() {
    if (retrying.size) return
    if (askAgain) clearTimeout(askAgain)
    askAgain = null; retryDelay = 0
  }
  function schedule() {
    if (closed || askAgain) return
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : RETRY_FIRST_MS, RETRY_MAX_MS)
    askAgain = setTimeout(() => { askAgain = null; void resume().catch(() => undefined) }, retryDelay)
  }
  function begin(task: AttachmentUploadTask, file: Blob, plan: AttachmentUploadPlan | null): Promise<void> {
    if (closed) return Promise.reject(new Error('Attachment upload host stopped'))
    if (dropped.has(task.messageId)) { dropped.set(task.messageId, true); return Promise.resolve() }
    const current = running.get(task.messageId)
    if (current) return current
    authWaiting.delete(task.messageId)
    const run = upload(task, file, plan).finally(() => {
      running.delete(task.messageId)
      if (dropped.has(task.messageId)) dropped.set(task.messageId, true)
      const woken = wakeAfterRun.delete(task.messageId)
      if (woken && authWaiting.has(task.messageId) && !dropped.has(task.messageId)) void resume(task.messageId).catch(() => undefined)
    })
    running.set(task.messageId, run)
    run.catch(() => undefined) // The caller and progress report the error; the server retains the pending duty.
    return run
  }
  function drop(messageId: string) {
    dropped.set(messageId, running.has(messageId))
    retrying.delete(messageId); terminal.delete(messageId); authWaiting.delete(messageId); wakeAfterRun.delete(messageId); clearRetry()
    host.progress(messageId)
  }
  function resume(messageId?: string): Promise<void> {
    if (closed) return Promise.resolve()
    if (messageId) requested.add(messageId)
    else allRequested = true
    // Coalesce calls from one turn, while retaining a wakeup that arrives during a server read.
    return resuming ??= Promise.resolve().then(async () => {
      while (!closed && (allRequested || requested.size)) {
        const only = allRequested ? null : new Set(requested)
        allRequested = false; requested.clear()
        await readPending(only)
      }
    }).finally(() => {
      resuming = null
      if (!closed && (allRequested || requested.size)) void resume().catch(() => undefined)
    })
  }
  async function readPending(only: Set<string> | null) {
    if (closed) return
    try {
      const uploads = await pendingAttachmentUploads(await host.endpoint())
      const pendingIds = new Set(uploads.map(upload => upload.message_id))
      for (const [id, observed] of dropped) if (observed && !pendingIds.has(id) && !running.has(id)) dropped.delete(id)
      for (const pending of uploads) {
        if (only && !only.has(pending.message_id)) continue
        if (closed || dropped.has(pending.message_id) || terminal.has(pending.message_id)) continue
        if (running.has(pending.message_id)) { wakeAfterRun.add(pending.message_id); continue }
        const file = await host.copyOf(pending.sha256)
        if (!file || closed || dropped.has(pending.message_id)) continue
        void begin({ messageId: pending.message_id, chatId: pending.chat_id, as: pending.as, pendingKey: pending.staging_key, sha256: pending.sha256,
          name: pending.file_name ?? '', contentType: pending.content_type, size: pending.size_bytes }, file, null)
      }
      if (retrying.size) schedule()
      else clearRetry()
    } catch (error) {
      if (!closed) {
        if (retryableAttachmentError(error)) schedule()
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
    try {
      const endpoint = await host.endpoint()
      const finished = await finishDeclaredAttachment(endpoint, { staging_key: task.pendingKey, size_bytes: task.size, ...(first ? { plan: first } : {}) },
        { bytes: file.slice(0, file.size, task.contentType), name: task.name, contentType: task.contentType }, { id: task.messageId, chat_id: task.chatId, as: task.as }, {
          signal: controller.signal,
          onProgress: (transfer, attempt) => {
            progress = { sha256: task.sha256, chatId: task.chatId, loaded: transfer.loaded, total: transfer.total ?? task.size, attempt }
            host.progress(task.messageId, progress)
          },
          declarationWaitMs: FINISH_WAIT_MS,
          stopped: () => closed || dropped.has(task.messageId),
        })
      if (!finished || closed) return
      retrying.delete(task.messageId); terminal.delete(task.messageId); clearRetry()
      host.progress(task.messageId)
    } catch (error) {
      if (closed || dropped.has(task.messageId)) return
      // A missing pending row is not a terminal receipt: its commit may still be in flight.
      const missing = error instanceof AttachmentsError && error.code === 'upload_not_found'
      const retryable = missing || retryableAttachmentError(error)
      const final = error instanceof AttachmentsError && !retryable && error.status !== 401
      if (error instanceof AttachmentsError && error.status === 401) authWaiting.add(task.messageId)
      if (final) { terminal.add(task.messageId); retrying.delete(task.messageId); clearRetry() }
      else if (retryable) { retrying.add(task.messageId); schedule() }
      host.progress(task.messageId, { ...progress, failed: true, final })
      host.warn?.(error)
      throw error
    } finally { controllers.delete(controller) }
  }
  return { begin, drop, retry: (messageId: string) => { terminal.delete(messageId); return resume(messageId) }, resume: () => resume(), dispose() {
    closed = true
    if (askAgain) clearTimeout(askAgain)
    for (const controller of controllers) controller.abort(new Error('Attachment upload host stopped'))
  } }
}
