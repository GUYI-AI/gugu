// 渲染层调 attachments 函数(core 的那一份客户端,packages/core/src/cloud/attachmentsApi.ts):这个构建的服务器,登录的人现在的令牌。
import { commitAttachment, configuredEndpoint, declareAttachment, placeAttachment, uploadAttachmentBytes, type AttachmentsEndpoint, type CommitArgs, type DeclaredAttachment } from '@gugu/core/cloud/attachmentsApi'
import { beginAttachmentUpload } from './attachmentUploads'
import { resolveFileMimeType, sniffFileMimeType } from '@gugu/core/shared/ui/attachmentModels'
import type { TurnFileRef } from '@gugu/session-core/session-record/contract'
import { isHeicLikeFile, mustCopyRatherThanReference } from '@renderer/lib/pty/terminal-image-paths'
import { getRendererAccessToken } from './sessionPublication'
import { rendererLogger } from './log'
import { i18n } from '../i18n'
import type { AttachmentUploadContext } from './taskAttachmentUpload'
import { pathOfFile } from './fileOnDisk'
import { prefetchTaskFiles, pushTaskFiles, pushTaskAttachment, taskAttachmentUsesSsh, taskAttachmentWorkspacePath, type TaskAttachmentTarget } from './taskAttachmentTarget'

// 令牌只读会话协调器已发布的那一份,和数据客户端(supabase.ts 的 accessToken)同一个来源:数据客户端没有自己的 auth 会话,
// 在它身上 auth.getSession() 直接抛(「configured with the accessToken option」)。
export async function attachmentsEndpoint(): Promise<AttachmentsEndpoint> {
  const token = getRendererAccessToken()
  if (!token) throw new Error('attachments: not signed in')
  return configuredEndpoint(token)
}

/**
 * Preparing does not publish a file. A cloud file is declared, not uploaded: its sha256 and size go into the message's
 * commit and its bytes go up behind it (attachmentUploads). A project chat's file is published by the ordered commit
 * with the same publisher as group-file Apps; its bytes stay on this device.
 */
export type PreparedChatAttachment = { staging_key: string; sha256: string; size_bytes: number } | { local: File }
async function publishNative(args: Record<string, unknown>) {
  try { return await window.electronAPI!.invoke('files:publish', args) }
  catch { throw new Error(i18n.t('attachmentView.fileUnavailable', { ns: 'messaging' })) }
}
async function cloudChatAttachment(endpoint: AttachmentsEndpoint, file: File, scope: { chat_id: string; as: string; message_id: string }, signal?: AbortSignal): Promise<PreparedChatAttachment> {
  const name = file.name || 'file', contentType = resolveFileMimeType(file)
  const native = globalThis.window?.electronAPI
  const path = native ? pathOfFile(file) : ''
  signal?.throwIfAborted()
  const drop = () => { void native?.invoke('attachments:drop', { messageId: scope.message_id }).catch(error => rendererLogger('chat/attachment-uploads').warn({ error: String(error) }, 'Attachment upload cancellation failed')) }
  signal?.addEventListener('abort', drop, { once: true })
  let declared: DeclaredAttachment
  try {
    declared = native
      ? await native.invoke('attachments:declare', { file: { name, path, size: file.size, contentType, ...(!path ? { data: await file.arrayBuffer() } : {}) },
        chatId: scope.chat_id, as: scope.as, messageId: scope.message_id }) as DeclaredAttachment
      : await declareAttachment(endpoint, { bytes: file, contentType }, { chat_id: scope.chat_id, as: scope.as, request_id: scope.message_id }, signal)
    signal?.throwIfAborted()
  } finally { signal?.removeEventListener('abort', drop) }
  // Renderer keeps a display copy; the native host owns the durable upload copy on desktop.
  try { await (await import('./attachmentBytes')).keepSentAttachment(file, declared.sha256) }
  catch (error) { drop(); throw error }
  if (signal?.aborted) { drop(); signal.throwIfAborted() }
  if (!native) void beginAttachmentUpload({ sha256: declared.sha256, messageId: scope.message_id, chatId: scope.chat_id, as: scope.as, pendingKey: declared.staging_key, name, contentType, size: file.size }, file, declared.plan ?? null)
  return { staging_key: declared.staging_key, sha256: declared.sha256, size_bytes: declared.size_bytes }
}
export async function prepareChatAttachment(endpoint: AttachmentsEndpoint, file: File, scope: { chat_id: string; as: string; is_whisper?: boolean; message_id: string }, signal?: AbortSignal): Promise<PreparedChatAttachment> {
  const native = globalThis.window?.electronAPI
  if (native && !scope.is_whisper && await publishNative({ chatId: scope.chat_id, contentType: resolveFileMimeType(file) }) === true) return { local: file }
  return cloudChatAttachment(endpoint, file, scope, signal)
}
export async function commitPreparedChatAttachment(endpoint: AttachmentsEndpoint, prepared: PreparedChatAttachment, args: Omit<CommitArgs, 'staging_key'>): Promise<Record<string, unknown>> {
  if ('staging_key' in prepared) return commitAttachment(endpoint, { ...args, staging_key: prepared.staging_key, sha256: prepared.sha256, size_bytes: prepared.size_bytes })
  if (args.is_whisper || !window.electronAPI) throw new Error('Project file audience changed')
  const file = prepared.local
  // A pasted file is memory-backed and has no disk path: hand main its bytes instead.
  const path = pathOfFile(file), data = path ? undefined : await file.arrayBuffer()
  const row = await publishNative({ chatId: args.chat_id, file: { name: file.name, path, size: file.size, contentType: resolveFileMimeType(file), ...(data && { data }) }, message: args }) as { id: string; version: number; message?: Record<string, unknown> } | null
  // This account's file storage setting changed after planning: the same cloud provider must authorize any upload afresh.
  if (!row) return commitPreparedChatAttachment(endpoint, await cloudChatAttachment(endpoint, file, { chat_id: args.chat_id, as: args.sender_user_id, message_id: args.message_id }), args)
  const message = row.message
  if (!message || message.id !== args.message_id || message.sender_user_id !== args.sender_user_id || message.chat_id !== args.chat_id || message.file_item_id !== row.id || message.file_version !== row.version) throw new Error('Project attachment was not committed')
  return message
}

/**
 * A task attachment named before it is placed (P3): on a desktop, the id its DM-folder file will take (new files are
 * version 1) and the file the agent works on — the dragged original, or one copy of a paste (or of an image the agent
 * cannot read as it is) written where agents' downloads land. A new task's first turn names its files this way before
 * the agent's DM exists; a task page places them right away. The phone has no file to hand over: it names nothing
 * beforehand (`placeTaskAttachment` without a prepared ref uploads).
 */
export async function prepareTaskAttachment(file: File): Promise<TurnFileRef | null> {
  const api = window.electronAPI
  if (!api) return null
  const name = file.name || 'file', mimeType = await sniffFileMimeType(file)
  const dropped = pathOfFile(file)
  const own = dropped && !mustCopyRatherThanReference(dropped) && !isHeicLikeFile(file)
  const copy = own ? null : await api.invoke('files:task-copy', { name, data: await file.arrayBuffer(), mimeType }) as { path: string; name: string; size: number; mimeType?: string }
  return { itemId: crypto.randomUUID(), version: 1, name: copy?.name ?? name, mimeType: copy?.mimeType ?? mimeType, sizeBytes: copy?.size ?? file.size, path: copy?.path ?? dropped }
}

/**
 * Places a task attachment in its agent's DM folder, with no message (P3). A desktop publishes it here only — metadata, the
 * bytes stay on this device and another device fetches them when it opens them (owner 10-31) — under the id `prepared`
 * named. The phone uploads it into the folder.
 */
export type TaskAttachmentPlacement = { published?: TurnFileRef; upload?: AttachmentUploadContext }
export async function placeTaskAttachment(file: File, prepared: TurnFileRef | null, to: TaskAttachmentTarget, onProgress?: (sent: number, total: number) => void,
  options: { signal?: AbortSignal; placement?: TaskAttachmentPlacement; resumable?: boolean; onPhase?: (phase: 'uploading' | 'resuming' | 'confirming') => void } = {}): Promise<TurnFileRef> {
  const { signal } = options
  const placement = options.placement ?? {}
  await sniffFileMimeType(file)
  signal?.throwIfAborted()
  if (prepared?.path) {
    if (!placement.published) {
      const row = await publishNative({ chatId: to.chatId, task: true, itemId: prepared.itemId,
        file: { name: prepared.name, path: prepared.path, size: prepared.sizeBytes, contentType: prepared.mimeType } }) as { id: string; version: number } | null
      if (!row || row.id !== prepared.itemId || row.version !== prepared.version) throw new Error('Task attachment was not published as named')
      placement.published = prepared
    }
    signal?.throwIfAborted()
    if (to.deviceId && taskAttachmentUsesSsh(to.deviceId)) {
      let source: Blob = file
      if (prepared.mimeType !== resolveFileMimeType(file)) {
        const copy = await (await import('@/session/renderer/lib/ipc')).rpcOn(null).app.readUserImageDataUrl(prepared.path)
        if (!copy.success) throw new Error(copy.error)
        signal?.throwIfAborted()
        source = await fetch(copy.dataUrl, { signal }).then(response => response.blob())
      }
      if (options.resumable) await pushTaskAttachment(to, prepared, source, placement.upload ??= {}, onProgress, signal, options.onPhase)
      else await pushTaskFiles(to, prepared.itemId, [{ segments: [prepared.name], size: source.size, slice: async (start, end) => new Uint8Array(await source.slice(start, end).arrayBuffer()) }], onProgress, signal)
      return { ...prepared, path: undefined, workspacePath: taskAttachmentWorkspacePath(prepared.itemId, prepared.name) }
    }
    if (to.deviceId) await prefetchTaskFiles(to, [prepared], signal)
    signal?.throwIfAborted()
    onProgress?.(prepared.sizeBytes, prepared.sizeBytes)
    return prepared
  }
  if (!placement.published) {
    const name = file.name || 'file', mimeType = resolveFileMimeType(file)
    const endpoint = await attachmentsEndpoint()
    const staging_key = await uploadAttachmentBytes(endpoint, { bytes: file, name, contentType: mimeType }, { chat_id: to.chatId, as: to.owner },
      { signal, onProgress: onProgress && (progress => onProgress(progress.loaded, progress.total ?? file.size)) })
    signal?.throwIfAborted()
    const item = await placeAttachment(endpoint, { staging_key, chat_id: to.chatId, file_name: name, as_user_id: to.owner, content_type: mimeType }) as { id: string; version: number }
    placement.published = { itemId: item.id, version: item.version, name, mimeType, sizeBytes: file.size }
  }
  signal?.throwIfAborted()
  await prefetchTaskFiles(to, [placement.published], signal)
  signal?.throwIfAborted()
  return placement.published
}
