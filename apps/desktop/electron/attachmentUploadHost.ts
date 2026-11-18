import { openAsBlob } from 'node:fs'
import { requireAgentFileAccess } from '@gugu/core/local/state/agentFileBoundary'
import { attachmentSha256, declareAttachment, type AttachmentsEndpoint, type DeclaredAttachment } from '@gugu/core/cloud/attachmentsApi'
import { createDeclaredUploads, type DeclaredUploadProgress } from '@gugu/core/cloud/declaredUploads'
import { storeBytes, storedCopy } from '@gugu/core/local/files/fileSnapshots'
import type { SelectedProjectFile } from './projectFilePublication'

export type AttachmentDeclareRequest = { file: SelectedProjectFile; chatId: string; as: string; messageId: string }
export interface AttachmentUploadIpc {
  invoke(channel: 'attachments:declare', request: AttachmentDeclareRequest): Promise<DeclaredAttachment>
  invoke(channel: 'attachments:drop' | 'attachments:retry', request: { messageId: string }): Promise<void>
  invoke(channel: 'attachments:resume'): Promise<void>
}
export type AttachmentProgressEvent = DeclaredUploadProgress & { messageId: string; done?: boolean }
export function createAttachmentUploadHost(deps: {
  account(): Promise<{ id: string; home: string; endpoint(): Promise<AttachmentsEndpoint> } | null>
  progress(event: AttachmentProgressEvent): void
  warn(error: unknown): void
  result?(result: { messageId: string; attempt: number; elapsedMs: number; outcome: 'success' | 'failed' }): void
}) {
  let current: { id: string; home: string; queue: ReturnType<typeof createDeclaredUploads> } | null = null
  const latest = new Map<string, { event: AttachmentProgressEvent; started: number }>()
  async function runtime() {
    const account = await deps.account()
    if (current?.id !== account?.id) { current?.queue.dispose(); current = null; latest.clear() }
    if (!account) return null
    if (!current) current = { id: account.id, home: account.home, queue: createDeclaredUploads({
      endpoint: async () => {
        const now = await deps.account()
        if (now?.id !== account.id) throw new Error('Attachment upload account changed')
        return now.endpoint()
      },
      copyOf: sha => storedCopy(account.home, sha), warn: deps.warn,
      progress: (messageId, progress) => {
        if (current?.id !== account.id) return
        const previous = latest.get(messageId)
        const started = previous && !(previous.event.failed && progress && !progress.failed) ? previous.started : performance.now()
        const event = progress ? { ...progress, messageId } : previous ? { ...previous.event, done: true } : null
        if (!event) return
        if (progress) latest.set(messageId, { event, started })
        else latest.delete(messageId)
        if (!progress || progress.failed) deps.result?.({ messageId, attempt: event.attempt, elapsedMs: Math.round(performance.now() - started), outcome: progress?.failed ? 'failed' : 'success' })
        deps.progress(event)
      },
    }) }
    return current
  }
  return {
    async declare(request: AttachmentDeclareRequest): Promise<DeclaredAttachment> {
      const host = await runtime()
      if (!host) throw new Error('Attachment uploader is not signed in')
      const { file } = request
      const bytes = file.data ? new Blob([file.data], { type: file.contentType }) : await openAsBlob(await requireAgentFileAccess(file.path), { type: file.contentType })
      if (bytes.size !== file.size) throw new Error('Attachment file size changed')
      const sha256 = await attachmentSha256(bytes)
      await storeBytes(host.home, sha256, file.name, bytes)
      const account = await deps.account()
      if (account?.id !== host.id) throw new Error('Attachment upload account changed')
      const copy = await storedCopy(host.home, sha256)
      if (!copy) throw new Error('Attachment stored bytes changed')
      const declared = await declareAttachment(await account.endpoint(), { bytes: copy, contentType: file.contentType },
        { chat_id: request.chatId, as: request.as, request_id: request.messageId })
      // Upload the immutable stored original, never a source path the sender may change after declaring it.
      if (current !== host) throw new Error('Attachment upload account changed')
      if (declared.sha256 !== sha256) throw new Error('Attachment stored bytes changed')
      void host.queue.begin({ messageId: request.messageId, chatId: request.chatId, as: request.as, pendingKey: declared.staging_key, sha256,
        name: file.name, contentType: file.contentType, size: file.size }, copy, declared.plan ?? null)
      return { staging_key: declared.staging_key, sha256, size_bytes: declared.size_bytes }
    },
    async drop(messageId: string) {
      const host = await runtime(), previous = latest.get(messageId)
      latest.delete(messageId)
      if (previous) deps.progress({ ...previous.event, done: true })
      host?.queue.drop(messageId)
    },
    async retry(messageId: string) { await (await runtime())?.queue.retry(messageId) },
    async resume() {
      const host = await runtime()
      for (const { event } of latest.values()) deps.progress(event)
      await host?.queue.resume()
    },
    dispose() { current?.queue.dispose(); current = null; latest.clear() },
  }
}
