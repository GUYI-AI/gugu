import type { OutboxWiring } from '../../store/chatOutboxWiring'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { formatAttachmentMetadata, inferAttachmentKind, resolveFileMimeType, sniffFileMimeType } from '@gugu/core/shared/ui/attachmentModels'
import { keepSentAttachment } from '../../lib/attachmentBytes'
import { rendererLogger } from '../../lib/log'
import { type AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { attachmentsEndpoint, prepareChatAttachment, type PreparedChatAttachment } from '../../lib/attachmentsEndpoint'
import { requireThreadCapableChat } from '../../lib/chatThreadGate'
import { attachmentSendTiming, attachmentUploadTimeoutMs, type AttachmentSendTiming } from '../../lib/attachmentSendTiming'
import { attachmentAttemptEndpoint, retryAttachmentUpload } from '../../lib/attachmentSendRecovery'
import { setAttachmentUploadProgress } from '../../lib/attachmentUploadProgress'
import { holdSentFile, dropSentFile } from '../../lib/sentFileCopies'
import { chatSendFailureReason } from './chatSendFailureNotice'
import { i18n } from '@/i18n'

// Bytes upload concurrently outside the lane. The existing outbox owns each source id
// from selection through commit, including failure and restart visibility.
// The composer lets go as soon as the rows are on screen: uploading belongs to the rows, never to the composer.
const UPLOAD_CONCURRENCY = 3

function startBoundedUploads(files: File[], endpoint: Promise<AttachmentsEndpoint>, scope: { chat_id: string; as: string; is_whisper?: boolean }, timings: AttachmentSendTiming[]): Promise<PreparedChatAttachment>[] {
  const settle: Array<{ resolve: (value: PreparedChatAttachment) => void; reject: (error: unknown) => void }> = []
  const results = files.map(() => new Promise<PreparedChatAttachment>((resolve, reject) => { settle.push({ resolve, reject }) }))
  // 未被 await 到的失败(中止点之后的件)不应成为 unhandledrejection。
  for (const result of results) result.catch(() => undefined)
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const index = next
      next += 1
      try {
        const file = files[index]
        const prepared = await retryAttachmentUpload(attempt => timings[index].stage('upload', attempt,
          (signal, capDeadline, progress) => {
            setAttachmentUploadProgress(timings[index].clientId)
            return endpoint.then(endpoint => prepareChatAttachment(attachmentAttemptEndpoint(endpoint, signal), file,
            { ...scope, request_id: timings[index].clientId }, plan => { capDeadline(plan.expires_at); progress() }, attempt > 1,
            transfer => { progress(transfer.loaded, transfer.total); setAttachmentUploadProgress(timings[index].clientId, { ...transfer, attempt }) }))
          },
          undefined, { timeoutMs: attachmentUploadTimeoutMs(file.size) }))
        settle[index].resolve(prepared)
      } catch (error) {
        timings[index].finish('failed', 'upload')
        settle[index].reject(error)
      } finally {
        setAttachmentUploadProgress(timings[index].clientId)
      }
    }
  }
  for (let lane = 0; lane < Math.min(UPLOAD_CONCURRENCY, files.length); lane += 1) void worker()
  return results
}

export async function placeholderRow(file: File, caption: string | undefined, args: { chatId: string; senderId: string; toUserIds: string[] | null; isWhisper?: boolean; replyToMessageId?: string | null; threadRootId?: string | null; isThreadRoot?: boolean }) {
  let dimensions: MessageItem['image_dimensions']
  if (inferAttachmentKind(file) === 'image') {
    try {
      const image = await createImageBitmap(file)
      try { dimensions = { width: image.width, height: image.height } } finally { image.close() }
    } catch { /* A local decoder need not support every uploadable image format. */ }
  }
  const previewUrl = URL.createObjectURL(file)
  const message: MessageItem = {
    id: crypto.randomUUID(),
    chat_id: args.chatId,
    sender_user_id: args.senderId,
    to_user_ids: args.toUserIds,
    is_whisper: !!args.isWhisper,
    seq: -1,
    content: formatAttachmentMetadata({
      kind: inferAttachmentKind(file),
      fileName: file.name || 'file',
      mimeType: resolveFileMimeType(file),
      url: previewUrl,
      sizeBytes: file.size,
      caption,
    }),
    content_type: 'attachment',
    reply_to_message_id: args.replyToMessageId ?? null,
    thread_root_id: args.threadRootId ?? null,
    is_thread_root: !!args.isThreadRoot,
    retracted_at: null,
    created_at: new Date().toISOString(),
    reactions: [],
    is_mine: true,
    delivered: false,
    delivery_status: null,
    local_send_state: 'sending',
    ...(dimensions ? { image_dimensions: dimensions } : {}),
  }
  // The row reads its file from this device until it is delivered (then under its committed address) or discarded.
  holdSentFile(message.id, file, previewUrl)
  const release = () => { dropSentFile(message.id) }
  return { message, release }
}

type BatchArgs = {
  files: File[]
  chatId: string
  senderId: string
  toUserIds: string[] | null
  isWhisper?: boolean
  replyToMessageId?: string | null
  threadRootId?: string | null
  isThreadRoot?: boolean
  caption?: string
  outbox: Pick<OutboxWiring, 'stageAttachment' | 'commitAttachment' | 'failAttachmentUpload'> & { outbox: Pick<OutboxWiring['outbox'], 'discard'> }
  appendMessage: (message: MessageItem) => void
}
type StagedRow = Awaited<ReturnType<typeof placeholderRow>>

/**
 * Puts one row per file on screen, owned by the outbox, and returns the last row's id once they are there (a text sent
 * with the files waits for it). Their bytes upload afterwards; a file that does not go up fails on its own row.
 * Throws only when no row was kept: the files then still belong to whoever passed them.
 */
export async function sendAttachmentBatch(args: BatchArgs): Promise<string | undefined> {
  if (!args.files.length) return undefined
  if (args.threadRootId != null || args.isThreadRoot === true) await requireThreadCapableChat(args.chatId, 'sendAttachmentBatch')
  await Promise.all(args.files.map(sniffFileMimeType))
  const captionIndex = args.files.findLastIndex(file => inferAttachmentKind(file) === 'image')
  const rows: StagedRow[] = []
  try {
    for (const [fileIndex, file] of args.files.entries()) {
      const row = await placeholderRow(file, fileIndex === captionIndex ? args.caption : undefined, args)
      rows.push(row)
      // Durable ownership precedes visibility; uploading does not block the lane.
      await args.outbox.stageAttachment(row.message)
      args.appendMessage(row.message)
    }
  } catch (error) {
    // A partially staged batch never leaves an upload marker with no upload task behind.
    for (const row of rows) {
      await args.outbox.outbox.discard(row.message.id)
      row.release()
    }
    throw error
  }
  const endpoint = attachmentsEndpoint()
  endpoint.catch(() => undefined) // each row reports it through its own upload
  const timings = rows.map(row => attachmentSendTiming(row.message.id, args.chatId))
  const uploads = startBoundedUploads(args.files, endpoint, { chat_id: args.chatId, as: args.senderId, is_whisper: args.isWhisper }, timings)
  void (async () => {
    // Commits keep the files' order: a later file never reaches the conversation before an earlier one that is ready.
    for (const [index, row] of rows.entries()) {
      await commitWhenUploaded(args, args.files[index], row, uploads[index], timings[index], index === captionIndex ? args.caption : undefined)
    }
  })().catch((error) => rendererLogger('chat/send').error({ chatId: args.chatId, error: String(error) }, 'attachment failure not recorded'))
  return rows.at(-1)?.message.id
}

async function commitWhenUploaded(args: BatchArgs, file: File, row: StagedRow, upload: Promise<PreparedChatAttachment>, timing: AttachmentSendTiming, caption: string | undefined): Promise<void> {
  try {
    const prepared = await upload
    // Uploaded bytes are kept by content before the commit, so the committed row draws them instead of downloading them again.
    if (inferAttachmentKind(file) === 'image') void keepSentAttachment(file).catch((error) => rendererLogger('chat/send').error({ error: String(error) }, 'sent image local copy not kept'))
    await args.outbox.commitAttachment(row.message, prepared, {
      message_id: row.message.id, chat_id: args.chatId, sender_user_id: args.senderId,
      file_name: file.name || 'file', content_type: resolveFileMimeType(file), to_user_ids: args.toUserIds ?? [],
      reply_to_message_id: args.replyToMessageId ?? null, thread_root_id: args.threadRootId ?? null,
      is_thread_root: !!args.isThreadRoot, is_whisper: !!args.isWhisper,
      ...(caption ? { caption } : {}),
    }, timing)
  } catch (error) {
    rendererLogger('chat/send').error({ chatId: args.chatId, messageId: row.message.id, error: String(error) }, 'attachment upload failed')
    // Resending uploads the same bytes again under the same row, signed in afresh (it may be much later).
    await args.outbox.failAttachmentUpload(row.message.id, error, chatSendFailureReason(error, i18n.getFixedT(null, 'messaging')), () => {
      const again = attachmentSendTiming(row.message.id, args.chatId)
      const [retried] = startBoundedUploads([file], attachmentsEndpoint(), { chat_id: args.chatId, as: args.senderId, is_whisper: args.isWhisper }, [again])
      void commitWhenUploaded(args, file, row, retried, again, caption)
        .catch((failure) => rendererLogger('chat/send').error({ chatId: args.chatId, error: String(failure) }, 'attachment failure not recorded'))
    })
  }
}
