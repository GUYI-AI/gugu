// Desktop is a client of the account's main-process queue; Android hosts the same queue in its renderer.
import { createDeclaredUploads, type AttachmentUploadTask, type DeclaredUploadProgress } from '@gugu/core/cloud/declaredUploads'
import type { AttachmentUploadPlan } from '@gugu/core/cloud/attachmentsApi'
import type { AttachmentProgressEvent } from '../../electron/attachmentUploadHost'
import { attachmentSendTiming } from './attachmentSendTiming'
import { xhrAttachmentUpload } from './attachmentUploadTransport'
import { failAttachmentUploadProgress, setAttachmentUploadProgress } from './attachmentUploadProgress'
import { noteAttachmentChanged } from './attachmentChanges'
import { rendererLogger } from './log'
export type { AttachmentUploadTask } from '@gugu/core/cloud/declaredUploads'

const log = rendererLogger('chat/attachment-uploads')
const timings = new Map<string, ReturnType<typeof attachmentSendTiming>>()
const copies = new Map<string, Blob>(), shas = new Map<string, string>()
const warn = (error: unknown) => log.warn({ error: String(error) }, 'Attachment upload host failed')
const native = globalThis.window?.electronAPI
const invoke = (channel: string, messageId?: string) => native!.invoke(channel, messageId ? { messageId } : {})
function progress(messageId: string, value?: DeclaredUploadProgress) {
  if (!native && value && !timings.has(messageId)) timings.set(messageId, attachmentSendTiming(messageId, value.chatId ?? ''))
  if (!value || value.failed) {
    timings.get(messageId)?.finish(value?.failed ? 'failed' : 'success', 'bytes')
    timings.delete(messageId)
  }
  if (value) {
    if (shas.get(messageId) !== value.sha256) {
      shas.set(messageId, value.sha256)
      void import('./attachmentBytes').then(async ({ cachedAttachmentCopy }) => {
        const file = await cachedAttachmentCopy(value.sha256)
        if (shas.get(messageId) !== value.sha256) return
        if (file) { copies.set(messageId, file); noteAttachmentChanged(messageId) }
        else shas.delete(messageId)
      }).catch(error => { if (shas.get(messageId) === value.sha256) shas.delete(messageId); warn(error) })
    }
    if (value.failed) failAttachmentUploadProgress(messageId, value.final ? undefined : () => { void retry(messageId).catch(warn) })
    else setAttachmentUploadProgress(messageId, value)
  } else {
    copies.delete(messageId); shas.delete(messageId)
    setAttachmentUploadProgress(messageId)
  }
}
const local = native ? null : createDeclaredUploads({
  endpoint: async () => ({ ...await (await import('./attachmentsEndpoint')).attachmentsEndpoint(), upload: xhrAttachmentUpload }),
  copyOf: async sha => (await import('./attachmentBytes')).cachedAttachmentCopy(sha), progress, warn,
  attempt: (task, attempt, run) => timings.get(task.messageId)!.stage('upload', attempt, run, undefined, { timeoutMs: null }),
})
native?.eventOn('attachments:progress', value => {
  const event = value as AttachmentProgressEvent
  progress(event.messageId, event.done ? undefined : event)
})
const retry = (messageId: string): Promise<unknown> => native ? invoke('attachments:retry', messageId) : local!.retry(messageId)
export function beginAttachmentUpload(task: AttachmentUploadTask, file: Blob, plan: AttachmentUploadPlan | null): Promise<void> {
  if (!local) throw new Error('Desktop attachment uploads begin in the native host')
  return local.begin(task, file, plan)
}
export function dropAttachmentUpload(messageId: string): void {
  timings.delete(messageId)
  if (native) void invoke('attachments:drop', messageId).catch(warn)
  else local!.drop(messageId)
  progress(messageId)
}
export async function resumeAttachmentUploads(): Promise<void> {
  if (native) await invoke('attachments:resume')
  else await local!.resume()
}
export const resumingCopy = (messageId: string): Blob | null => copies.get(messageId) ?? null
