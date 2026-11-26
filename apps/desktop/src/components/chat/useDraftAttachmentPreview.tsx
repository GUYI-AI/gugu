import { useEffect, useState } from 'react'
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs'
import type { ComposerAttachment } from '@gugu/session-ui/react/components'
import { workingCopyImageItem } from '@/lib/attachmentBytes'
import { openComposerImage, openImageViewer } from '@/lib/imageViewer'
import { Sheet } from '../ui/Sheet'
import { MessageFilePreview, type HostedPreviewFile } from './MessageFilePreview'

export type DraftAttachmentReplace = (id: string, file: File, caption: string, original: File) => void | Promise<void>

/** A picked file opens from the draft's own bytes, regardless of its upload state. An image edited there comes back through `replace`. */
export function useDraftAttachmentPreview(
  scope: string | null | undefined, visible: boolean, fileOf: (id: string) => File | undefined,
  replace?: DraftAttachmentReplace,
) {
  const [preview, setPreview] = useState<{ scope: typeof scope; file: HostedPreviewFile } | null>(null)
  const current = visible && preview?.scope === scope ? preview : null
  useEffect(() => { if (preview && !current) setPreview(null) }, [preview, current])

  function open(attachment: ComposerAttachment, cell?: HTMLElement) {
    const file = fileOf(attachment.id)
    const edit = file && replace ? (edited: File, caption: string) => replace(attachment.id, edited, caption, file) : undefined
    if (openComposerImage(attachment, cell, edit)) return
    if (!file) return
    const read = async () => file
    if (isRenderableImage(file.name, file.type)) {
      openImageViewer([{ ...workingCopyImageItem(file.name, read), ...(edit ? { replace: edit } : {}) }])
      return
    }
    setPreview({ scope, file: {
      kind: attachment.kind,
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      source: { kind: 'hosted', key: attachment.id, read },
    } })
  }

  const close = () => setPreview(null)
  return {
    open,
    panel: current && <Sheet fullScreenMobile ariaLabel={current.file.fileName} onClose={close} testId="draft-attachment-preview">
      <MessageFilePreview mobile readOnly file={current.file} onClose={close} />
    </Sheet>,
  }
}
