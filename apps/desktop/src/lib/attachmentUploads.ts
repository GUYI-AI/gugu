// The bytes of a sent attachment go up after its message (owner 11-15: a message is its text and its files' index). The
// message declared them (sha256, size) and was delivered at once; here they upload in the background and are finished:
// the server hashes them against the declaration and the attachment becomes readable everywhere. Nothing here is a
// second record of what is still to upload: the server answers that (pending), and the bytes are this device's copy of
// what it sent, kept by content before the commit (keepSentAttachment). A restart asks the server and resumes each one
// this device still holds. Progress is the attachment's state, keyed by its message id (attachmentUploadProgress): the
// bubble draws it, the message's delivery and reads never see it.
import { AttachmentsError, finishAttachment, pendingAttachmentUploads, planAttachmentUpload, uploadAttachmentPlan, type AttachmentUploadPlan } from '@gugu/core/cloud/attachmentsApi'
import { attachmentAttemptEndpoint, attachmentSendTiming } from './attachmentSendTiming'
import { failAttachmentUploadProgress, setAttachmentUploadProgress } from './attachmentUploadProgress'
import { noteAttachmentChanged } from './attachmentChanges'
import { rendererLogger } from './log'

const log = rendererLogger('chat/attachment-uploads')
export type AttachmentUploadTask = { messageId: string; chatId: string; as: string; pendingKey: string; name: string; contentType: string; size: number }
/** How long a finish waits for its message's commit (the declaration) before the upload reads failed (retry starts over). */
const FINISH_WAIT_MS = 120_000
const MAX_ATTEMPTS = 3
const running = new Map<string, Promise<void>>()
/** The copies a restart is uploading again, by message id: the sender's own bubble draws them under its ring. */
const resuming = new Map<string, Blob>()
/** Uploads whose message was discarded before it was sent: whatever of theirs is still running stops at its next step. */
const dropped = new Set<string>()

/** Starts (once per message) uploading a declared attachment's bytes under the plan its commit names. */
export function beginAttachmentUpload(task: AttachmentUploadTask, file: Blob, plan: AttachmentUploadPlan | null): Promise<void> {
  const current = running.get(task.messageId)
  if (current) return current
  const run = upload(task, file, plan).finally(() => running.delete(task.messageId))
  running.set(task.messageId, run)
  run.catch(() => undefined) // its failure is the attachment's state (failed + retry), not an unhandled rejection
  return run
}

/** Its message was discarded unsent: nothing will finish these bytes, so they are not uploaded any further. */
export function dropAttachmentUpload(messageId: string): void {
  if (!running.has(messageId)) return
  dropped.add(messageId)
  setAttachmentUploadProgress(messageId)
}

/** The copy a restart is uploading again for this message, if any. */
export function resumingCopy(messageId: string): Blob | null {
  return resuming.get(messageId) ?? null
}

/**
 * This account's declared attachments whose bytes have not arrived (the server's list): each one this device still
 * holds goes up again under a new plan and finishes its declaration. Another device's sends are left to it.
 */
export async function resumeAttachmentUploads(): Promise<void> {
  const endpoint = await uploadsEndpoint()
  const { cachedAttachmentCopy } = await import('./attachmentBytes')
  for (const pending of await pendingAttachmentUploads(endpoint)) {
    if (running.has(pending.message_id)) continue
    const file = await cachedAttachmentCopy(pending.sha256)
    if (!file) continue
    resuming.set(pending.message_id, file)
    noteAttachmentChanged(pending.message_id) // the sender's bubble draws its copy under the ring
    void beginAttachmentUpload({ messageId: pending.message_id, chatId: pending.chat_id, as: pending.as, pendingKey: pending.staging_key,
      name: '', contentType: pending.content_type, size: pending.size_bytes }, file, null)
      .then(() => { resuming.delete(pending.message_id) }, () => undefined)
  }
}

async function upload(task: AttachmentUploadTask, file: Blob, first: AttachmentUploadPlan | null): Promise<void> {
  const timing = attachmentSendTiming(task.messageId, task.chatId)
  setAttachmentUploadProgress(task.messageId, { loaded: 0, total: task.size, attempt: 1 })
  try {
    let plan = first, uploadKey = first ? task.pendingKey : null
    for (let attempt = 1; ; attempt++) {
      try {
        await timing.stage('upload', attempt, async (signal, capDeadline, progress) => {
          const endpoint = attachmentAttemptEndpoint(await uploadsEndpoint(), signal)
          plan ??= await planAttachmentUpload(endpoint, { size: task.size, contentType: task.contentType }, { chat_id: task.chatId, as: task.as }, signal)
          uploadKey ??= (plan as AttachmentUploadPlan & { staging_key: string }).staging_key
          capDeadline(plan.expires_at); progress()
          await uploadAttachmentPlan(endpoint, plan, { bytes: file, name: task.name || 'file', contentType: task.contentType }, attempt > 1, transfer => {
            progress(transfer.loaded, transfer.total)
            setAttachmentUploadProgress(task.messageId, { loaded: transfer.loaded, total: transfer.total ?? task.size, attempt })
          }, signal)
        }, undefined, { timeoutMs: null })
        break
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error
        plan = null; uploadKey = null // a new plan: the old one may have expired or its object be half written
        await new Promise(resolve => setTimeout(resolve, attempt * 1000))
      }
    }
    if (dropped.has(task.messageId)) return
    await finish(task, uploadKey!)
    timing.finish('success', 'bytes')
    setAttachmentUploadProgress(task.messageId)
  } catch (error) {
    if (dropped.has(task.messageId)) return
    timing.finish('failed', 'bytes')
    log.warn({ messageId: task.messageId, chatId: task.chatId, error: String(error) }, 'attachment bytes did not go up')
    // Mismatch: these bytes will never be the declared file; anything else can go up again from the same copy.
    const final = error instanceof AttachmentsError && error.code === 'upload_mismatch'
    failAttachmentUploadProgress(task.messageId, final ? undefined : () => { void beginAttachmentUpload(task, file, null) })
    throw error
  }
}

/** The declaration lands with the message's commit; bytes that beat it wait for it (bounded), then finish. */
async function finish(task: AttachmentUploadTask, uploadKey: string): Promise<void> {
  const until = Date.now() + FINISH_WAIT_MS
  for (let wait = 500; ; wait = Math.min(wait * 2, 8000)) {
    try {
      await finishAttachment(await uploadsEndpoint(), { staging_key: task.pendingKey, ...(uploadKey !== task.pendingKey ? { upload_key: uploadKey } : {}),
        file_name: task.name, content_type: task.contentType, message_id: task.messageId })
      return
    } catch (error) {
      if (!(error instanceof AttachmentsError && error.code === 'upload_not_found') || Date.now() + wait > until || dropped.has(task.messageId)) throw error
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}

// attachmentsEndpoint starts these uploads, so it is loaded when one runs, not imported: no cycle between the two modules.
const uploadsEndpoint = async () => (await import('./attachmentsEndpoint')).attachmentsEndpoint()
