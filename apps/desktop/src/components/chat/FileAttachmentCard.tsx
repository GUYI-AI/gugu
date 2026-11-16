import type { CSSProperties } from 'react'
import { metadataSeparator } from '@/i18n/format'
import { Download } from '@/lib/icons'
import { formatAttachmentSize, type AttachmentMeta } from '@gugu/core/shared/ui/attachmentModels'
import { attachmentTypeKey } from '@gugu/core/shared/ui/attachmentType'
import { fileRowStyle } from '@gugu/session-shared/file-row'
import { FileMark } from '@gugu/session-ui/file-mark'
import '@gugu/session-shared/file-row.css'
import type { ResourceContext } from '@/session/shared/resource-actions'
import { ResourceMenu } from '../ResourceMenu'
import { IconButton } from '../ui/IconButton'
import { useTranslation } from 'react-i18next'
import './fileAttachmentCard.css'

interface FileAttachmentCardProps {
  resource?: ResourceContext
  file: Pick<AttachmentMeta, 'fileName' | 'sizeBytes' | 'mimeType'> & { kind?: AttachmentMeta['kind'] }
  isMine?: boolean
  details?: string
  /** The folder file's version this message pins, already worded ("第 2 版"): shown before the size. */
  versionLabel?: string
  onOpen?: () => void
  onDownload?: () => void
  downloadLabel?: string
}

/**
 * A document in a message: the task page's file row (`@gugu/session-shared/file-row`), so a file is one shape everywhere.
 * Opening is the row's main button; a download sits beside it in the row's end slot, never inside it.
 */
export function FileAttachmentCard({ file, isMine = false, details, versionLabel, onOpen, onDownload, downloadLabel, resource }: FileAttachmentCardProps) {
  const { t } = useTranslation('messaging')
  const type = attachmentTypeKey(file)
  const metadata = [versionLabel, formatAttachmentSize(file.sizeBytes), type ? t(`attachmentView.types.${type}`) : null].filter(Boolean).join(metadataSeparator())
  const card = (
    <div className="gg-file-rows gg-hfile" data-mine={isMine || undefined} style={fileRowStyle() as CSSProperties}>
      <div className="gg-file-row" data-kind="file">
        <button type="button" className="gg-file-row-main" onClick={onOpen} disabled={!onOpen} aria-label={file.fileName} title={file.fileName}>
          <span className="gg-file-row-icon">
            <FileMark name={file.fileName} mime={file.mimeType} off={file.kind === 'image'} />
          </span>
          <span className="gg-file-row-text">
            <span className="gg-file-row-name">{file.fileName}</span>
            <span className="gg-file-row-detail">{details ?? metadata}</span>
          </span>
        </button>
        {onDownload && (
          <IconButton
            size="sm"
            className="gg-file-row-end gg-hdl -mr-1.5"
            title={downloadLabel}
            aria-label={downloadLabel ?? `Download ${file.fileName}`}
            onClick={(event) => { event.stopPropagation(); onDownload() }}
          >
            <Download size={16} aria-hidden="true" />
          </IconButton>
        )}
      </div>
    </div>
  )
  return resource ? <ResourceMenu resource={resource}>{card}</ResourceMenu> : card
}
