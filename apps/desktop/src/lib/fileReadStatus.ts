import type { TFunction } from 'i18next'
import { FileReadError, type FileReadState } from '@gugu/core/shared/fileReads'
import { FileReadRevokedError } from '@gugu/core/shared/fileResolver'
import { formatAttachmentSize } from '@gugu/core/shared/ui/attachmentModels'
import { messageForUser } from './userFacingError'

// What a reader is told about one file read, wherever it shows: the file preview and the image viewer say the same words.
export type ReadProgress = { label: string; fraction?: number }
export type ReadFailure = { errorStatus: 'gone' | 'expired' | 'missing' | 'failed'; retryable?: boolean; error: string }

export function fileReadProgress(t: TFunction<'messaging'>, update: (next: ReadProgress) => void) {
  let waitingSince: number | undefined, fraction: number | undefined
  return (state: FileReadState) => {
    if (state.status === 'waiting_sender') {
      waitingSince ??= performance.now()
      const seconds = Math.floor((performance.now() - waitingSince) / 1_000)
      const device = state.holder?.label?.trim()
      const label = device ? t('attachmentView.waitingForDevice', { device }) : t('attachmentView.senderUploading')
      update({ label: seconds ? t('attachmentView.waitedForUpload', { label, seconds }) : label })
    } else if (state.status === 'transferring') {
      const label = t(state.route === 'local' ? 'attachmentView.readFromDevice' : state.route === 'ssh' ? 'attachmentView.readOverSsh' : 'attachmentView.readFromOss')
      if (state.done === undefined || state.total === undefined || state.total <= 0) {
        fraction = undefined
        update({ label })
        return
      }
      fraction = Math.min(1, state.done / state.total)
      update({ label: t('attachmentView.bytesRead', { label, done: formatAttachmentSize(state.done), total: formatAttachmentSize(state.total) }), fraction })
    } else if (state.status === 'verifying') {
      update({ label: t('attachmentView.verifyingFile'), fraction })
    }
  }
}

export function fileReadFailure(error: unknown, t: TFunction<'messaging'>): ReadFailure {
  if (error instanceof FileReadError && error.cause instanceof FileReadRevokedError) return fileReadFailure(error.cause, t)
  if (error instanceof FileReadRevokedError && (error.reason === 'access' || error.reason === 'revision') || error instanceof FileReadError && error.code === 'access_revoked') {
    return { errorStatus: 'failed', error: t(error instanceof FileReadRevokedError && error.reason === 'revision' ? 'attachmentView.fileUpdated' : 'attachmentView.fileNoAccess') }
  }
  if (error instanceof FileReadError && error.code === 'holder_offline') return { errorStatus: 'failed', error: messageForUser(error) }
  if (error instanceof FileReadError && error.code === 'transfer_disabled') return { errorStatus: 'failed', error: t('attachmentView.fileTransferDisabled') }
  if (error instanceof FileReadError && error.code === 'upload_failed' || error instanceof Error && error.message === 'unsent') {
    return { errorStatus: 'failed', error: t('attachmentView.senderUploadFailed') }
  }
  const statusOrMessage = error instanceof FileReadError ? error.code : error instanceof Error ? error.message : undefined
  const errorStatus = statusOrMessage === 'gone' || statusOrMessage === 'expired' || statusOrMessage === 'missing' ? statusOrMessage : 'failed'
  const status = (error as { status?: number } | null)?.status
  const retryable = errorStatus === 'failed' && (error instanceof FileReadError ? error.code === 'interrupted' || error.code === 'integrity_failed' : !(status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429))
  return { errorStatus, retryable, error: t(errorStatus === 'gone' ? 'attachmentView.fileGone' : errorStatus === 'expired' ? 'attachmentView.fileExpired' : errorStatus === 'missing' ? 'attachmentView.fileMissing' : 'attachmentView.fileUnavailable') }
}
