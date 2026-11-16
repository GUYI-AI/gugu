// The bytes of a sent attachment go up after its message (owner 11-15: a message is its text and its files' index). The
// message declared them (sha256, size) and was delivered at once; here they upload in the background and are finished:
// the server hashes them against the declaration and the attachment becomes readable everywhere. Nothing here is a
// second record of what is still to upload: the server answers that (pending), and the bytes are this device's copy of
// what it sent, kept by content before the commit (keepSentAttachment). A restart asks the server and resumes each one
// this device still holds. Progress is the attachment's state, keyed by its message id (attachmentUploadProgress): the
// bubble draws it, the message's delivery and reads never see it.
import { AttachmentsError, finishDeclaredAttachment, pendingAttachmentUploads, type AttachmentUploadPlan, type PendingAttachmentUpload } from '@gugu/core/cloud/attachmentsApi'
import { attachmentAttemptEndpoint, attachmentSendTiming } from './attachmentSendTiming'
import { failAttachmentUploadProgress, setAttachmentUploadProgress } from './attachmentUploadProgress'
import { noteAttachmentChanged } from './attachmentChanges'
import { rendererLogger } from './log'

const log = rendererLogger('chat/attachment-uploads')
export type AttachmentUploadTask = { messageId: string; chatId: string; as: string; pendingKey: string; name: string; contentType: string; size: number }
/** How long a finish waits for its message's commit (the declaration) before the upload reads failed (retry starts over). */
const FINISH_WAIT_MS = 120_000
/** A failed upload tries again by itself, first after this long, then twice as long each time, at most a minute apart. */
const RETRY_FIRST_MS = 5_000
const RETRY_MAX_MS = 60_000
const running = new Map<string, Promise<void>>()
/** The copies a restart is uploading again, by message id: the sender's own bubble draws them under its ring. */
const resuming = new Map<string, Blob>()
/** Uploads whose message was discarded before it was sent: whatever of theirs is still running stops at its next step. */
const dropped = new Set<string>()
/** Failed uploads waiting to try again by themselves: a connection that comes back is used without anyone pressing retry. */
const again = new Map<string, { timer: ReturnType<typeof setTimeout>; delay: number }>()
/** The server's list could not be read (offline, a passing 5xx): it is asked again by itself, on the same schedule. */
let askAgain: { timer: ReturnType<typeof setTimeout>; delay: number } | null = null

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
  const later = again.get(messageId)
  if (later) { clearTimeout(later.timer); again.delete(messageId); setAttachmentUploadProgress(messageId) }
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
  let uploads: PendingAttachmentUpload[]
  try {
    uploads = await pendingAttachmentUploads(await uploadsEndpoint())
  } catch (error) {
    const delay = Math.min(askAgain ? askAgain.delay * 2 : RETRY_FIRST_MS, RETRY_MAX_MS)
    if (askAgain) clearTimeout(askAgain.timer)
    askAgain = { delay, timer: setTimeout(() => { void resumeAttachmentUploads().catch(() => undefined) }, delay) }
    log.warn({ error: String(error), retryInMs: delay }, 'pending attachment uploads not read')
    throw error
  }
  if (askAgain) { clearTimeout(askAgain.timer); askAgain = null }
  const { cachedAttachmentCopy } = await import('./attachmentBytes')
  for (const pending of uploads) {
    if (running.has(pending.message_id)) continue
    const file = await cachedAttachmentCopy(pending.sha256)
    if (!file) continue
    resuming.set(pending.message_id, file)
    noteAttachmentChanged(pending.message_id) // the sender's bubble draws its copy under the ring
    void beginAttachmentUpload({ messageId: pending.message_id, chatId: pending.chat_id, as: pending.as, pendingKey: pending.staging_key,
      name: pending.file_name ?? '', contentType: pending.content_type, size: pending.size_bytes }, file, null)
      .then(() => { resuming.delete(pending.message_id) }, () => undefined)
  }
}

async function upload(task: AttachmentUploadTask, file: Blob, first: AttachmentUploadPlan | null): Promise<void> {
  const timing = attachmentSendTiming(task.messageId, task.chatId)
  setAttachmentUploadProgress(task.messageId, { loaded: 0, total: task.size, attempt: 1 })
  // The running attempt's stage: the plan's expiry caps its deadline, bytes going up keep it alive.
  let stage: { capDeadline: (expiresAt: string | undefined) => void; progress: (sent?: number, total?: number) => void } | null = null
  try {
    const endpoint = await uploadsEndpoint()
    const finished = await finishDeclaredAttachment(endpoint, { staging_key: task.pendingKey, size_bytes: task.size, ...(first ? { plan: first } : {}) },
      { bytes: file, name: task.name, contentType: task.contentType }, { id: task.messageId, chat_id: task.chatId, as: task.as }, {
        attempt: (attempt, run) => timing.stage('upload', attempt, async (signal, capDeadline, progress) => {
          stage = { capDeadline, progress }
          await run(attachmentAttemptEndpoint(endpoint, signal), signal)
        }, undefined, { timeoutMs: null }),
        onPlan: plan => { stage?.capDeadline(plan.expires_at); stage?.progress() },
        onProgress: (transfer, attempt) => {
          stage?.progress(transfer.loaded, transfer.total)
          setAttachmentUploadProgress(task.messageId, { loaded: transfer.loaded, total: transfer.total ?? task.size, attempt })
        },
        declarationWaitMs: FINISH_WAIT_MS,
        stopped: () => dropped.has(task.messageId),
      })
    if (!finished) return
    again.delete(task.messageId)
    timing.finish('success', 'bytes')
    setAttachmentUploadProgress(task.messageId)
  } catch (error) {
    if (dropped.has(task.messageId)) return
    timing.finish('failed', 'bytes')
    log.warn({ messageId: task.messageId, chatId: task.chatId, error: String(error) }, 'attachment bytes did not go up')
    // Mismatch: these bytes will never be the declared file; anything else can go up again from the same copy.
    const final = error instanceof AttachmentsError && error.code === 'upload_mismatch'
    if (!final) tryAgainLater(task, file)
    failAttachmentUploadProgress(task.messageId, final ? undefined : () => { void beginAttachmentUpload(task, file, null) })
    throw error
  }
}

function tryAgainLater(task: AttachmentUploadTask, file: Blob): void {
  const delay = Math.min(again.has(task.messageId) ? again.get(task.messageId)!.delay * 2 : RETRY_FIRST_MS, RETRY_MAX_MS)
  const timer = setTimeout(() => { if (again.get(task.messageId)?.timer === timer) void beginAttachmentUpload(task, file, null) }, delay)
  again.set(task.messageId, { timer, delay })
}

// attachmentsEndpoint starts these uploads, so it is loaded when one runs, not imported: no cycle between the two modules.
const uploadsEndpoint = async () => (await import('./attachmentsEndpoint')).attachmentsEndpoint()
