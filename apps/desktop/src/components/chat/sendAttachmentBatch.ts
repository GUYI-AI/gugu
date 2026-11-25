import type { OutboxWiring } from '../../store/chatOutboxWiring'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { TurnAnnotation } from '@gugu/session-core/acp/client'
import { formatAttachmentMetadata, inferAttachmentKind, resolveFileMimeType, sniffFileMimeType } from '@gugu/core/shared/ui/attachmentModels'
import { rendererLogger } from '../../lib/log'
import { SEND_GROUP_MAX_FILES, type AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { attachmentsEndpoint, prepareChatAttachment, type PreparedChatAttachment } from '../../lib/attachmentsEndpoint'
import { requireThreadCapableChat } from '../../lib/chatThreadGate'
import { attachmentAttemptEndpoint, attachmentSendTiming, retryAttachmentUpload, type AttachmentSendTiming } from '../../lib/attachmentSendTiming'
import { holdSentFile, dropSentFile } from '../../lib/sentFileCopies'
import { chatSendFailureReason } from './chatSendFailureNotice'
import { i18n } from '@/i18n'

// A file is declared (its sha256, a plan) before its row commits; its bytes go up behind the message (attachmentUploads).
// The composer lets go as soon as the rows are on screen: sending belongs to the rows, never to the composer.
function prepareAll(files: File[], endpoint: Promise<AttachmentsEndpoint>, scope: { chat_id: string; as: string; is_whisper?: boolean }, timings: AttachmentSendTiming[]): Promise<PreparedChatAttachment>[] {
  return files.map((file, index) => {
    const prepared = retryAttachmentUpload(attempt => timings[index].stage('prepare', attempt, signal => endpoint.then(endpoint =>
      prepareChatAttachment(attachmentAttemptEndpoint(endpoint, signal), file, { ...scope, message_id: timings[index].clientId }, signal))))
    prepared.catch(() => timings[index].finish('failed', 'prepare'))
    return prepared
  })
}

/** What the send says beside its files, carried by the last one: the typed caption and the comments. */
type Words = { caption?: string; annotations?: TurnAnnotation[] }

export async function placeholderRow(file: File, words: Words | undefined, args: { chatId: string; senderId: string; toUserIds: string[] | null; isWhisper?: boolean; replyToMessageId?: string | null; threadRootId?: string | null; isThreadRoot?: boolean }, sendGroup?: SendGroup) {
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
      caption: words?.caption,
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
    ...(sendGroup ? { send_group_id: sendGroup.id, send_group_size: sendGroup.size } : {}),
    ...(words?.annotations?.length ? { annotations: words.annotations } : {}),
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
  annotations?: TurnAnnotation[]
  outbox: Pick<OutboxWiring, 'stageAttachment' | 'commitAttachment' | 'failAttachmentUpload'> & { outbox: Pick<OutboxWiring['outbox'], 'discard'> }
  appendMessage: (message: MessageItem) => void
}
type StagedRow = Awaited<ReturnType<typeof placeholderRow>>
/** #2581 Files sent at once are one message: their rows share one id and say how many files the send holds. */
type SendGroup = { id: string; size: number }

/** Each file's send: every SEND_GROUP_MAX_FILES files in a row are one send; a file left on its own is no send of several. */
function sendGroupsOf(count: number): (SendGroup | undefined)[] {
  const groups: (SendGroup | undefined)[] = []
  for (let start = 0; start < count; start += SEND_GROUP_MAX_FILES) {
    const size = Math.min(SEND_GROUP_MAX_FILES, count - start)
    const group = size > 1 ? { id: crypto.randomUUID(), size } : undefined
    groups.push(...Array<SendGroup | undefined>(size).fill(group))
  }
  return groups
}

/**
 * Puts one row per file on screen, owned by the outbox, and returns the last row's id once they are there. Several files
 * are one send (#2581), up to SEND_GROUP_MAX_FILES of them, then the next send: their rows share a group and the text rides on the
 * last file, so the conversation shows one message per send. Each is declared and committed, then its bytes go up behind the message; a send that does not commit fails on its own row.
 * Throws only when no row was kept: the files then still belong to whoever passed them.
 */
export async function sendAttachmentBatch(args: BatchArgs): Promise<string | undefined> {
  if (!args.files.length) return undefined
  if (args.threadRootId != null || args.isThreadRoot === true) await requireThreadCapableChat(args.chatId, 'sendAttachmentBatch')
  await Promise.all(args.files.map(sniffFileMimeType))
  // The text is the message's, written under all of it: it rides on the last file, whatever kind it is.
  const captionIndex = args.files.length - 1
  const words: Words = { caption: args.caption, ...(args.annotations?.length ? { annotations: args.annotations } : {}) }
  const sendGroups = sendGroupsOf(args.files.length)
  const rows: StagedRow[] = []
  try {
    for (const [fileIndex, file] of args.files.entries()) {
      const row = await placeholderRow(file, fileIndex === captionIndex ? words : undefined, args, sendGroups[fileIndex])
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
  const prepared = prepareAll(args.files, endpoint, { chat_id: args.chatId, as: args.senderId, is_whisper: args.isWhisper }, timings)
  void (async () => {
    // Commits keep the files' order: a later file never reaches the conversation before an earlier one that is ready.
    for (const [index, row] of rows.entries()) {
      await commitWhenPrepared(args, args.files[index], row, prepared[index], timings[index], index === captionIndex ? words : undefined, sendGroups[index])
    }
  })().catch((error) => rendererLogger('chat/send').error({ chatId: args.chatId, error: String(error) }, 'attachment failure not recorded'))
  return rows.at(-1)?.message.id
}

async function commitWhenPrepared(args: BatchArgs, file: File, row: StagedRow, preparing: Promise<PreparedChatAttachment>, timing: AttachmentSendTiming, words: Words | undefined, sendGroup: SendGroup | undefined): Promise<void> {
  // Declares the same file again under the same row, signed in afresh (it may be much later): a resend after it failed,
  // or after the commit found the upload's permit lapsed.
  const uploadAgain = () => {
    const again = attachmentSendTiming(row.message.id, args.chatId)
    const [retried] = prepareAll([file], attachmentsEndpoint(), { chat_id: args.chatId, as: args.senderId, is_whisper: args.isWhisper }, [again])
    void commitWhenPrepared(args, file, row, retried, again, words, sendGroup)
      .catch((failure) => rendererLogger('chat/send').error({ chatId: args.chatId, error: String(failure) }, 'attachment failure not recorded'))
  }
  try {
    const prepared = await preparing
    await args.outbox.commitAttachment(row.message, prepared, {
      message_id: row.message.id, chat_id: args.chatId, sender_user_id: args.senderId,
      file_name: file.name || 'file', content_type: resolveFileMimeType(file), to_user_ids: args.toUserIds ?? [],
      reply_to_message_id: args.replyToMessageId ?? null, thread_root_id: args.threadRootId ?? null,
      is_thread_root: !!args.isThreadRoot, is_whisper: !!args.isWhisper,
      ...(words?.caption ? { caption: words.caption } : {}),
      ...(words?.annotations?.length ? { annotations: words.annotations } : {}),
      ...(sendGroup ? { send_group_id: sendGroup.id, send_group_size: sendGroup.size } : {}),
    }, timing, undefined, uploadAgain)
  } catch (error) {
    rendererLogger('chat/send').error({ chatId: args.chatId, messageId: row.message.id, error: String(error) }, 'attachment send failed')
    await args.outbox.failAttachmentUpload(row.message.id, error, chatSendFailureReason(error, i18n.getFixedT(null, 'messaging')), uploadAgain)
  }
}
