import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FilePreviewHost } from './filePreviewHost'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { platform } from '../../platform'
import { Sheet } from '../ui/Sheet'
import { useBackLayer } from '../ui/sheetStack'
import { openLinkTarget, OpenSuperseded } from '../../lib/guguLinks'
import { MessageFilePreview, type PreviewFile } from './MessageFilePreview'
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs'
import { TrackCut } from '@renderer/features/tabs/pane-track-cut'
import { openAttachmentImage } from '../../lib/attachmentBytes'

export type { PreviewFile } from './MessageFilePreview'

const fileOpenLog = rendererLogger('chat/file-open')

export function useMessageFilePreview({ mobile, visible, closeRightSurfaces, toast, onForward, readOnly = false }: {
  mobile: boolean
  visible: boolean
  closeRightSurfaces: () => void
  toast: (message: string, kind: 'error', description?: string) => void
  onForward?: (message: MessageItem) => void
  readOnly?: boolean
}) {
  const { t } = useTranslation('messaging')
  const downloadFailed = t('chatArea.downloadFailed')
  const host = useContext(FilePreviewHost)
  const hosted = host !== null
  const onOpenChange = host?.onOpenChange
  const [preview, setPreview] = useState<{ file: PreviewFile; message?: MessageItem; opening: number } | null>(null)
  const isOpen = preview !== null
  useEffect(() => {
    onOpenChange?.(isOpen)
    return () => onOpenChange?.(false)
  }, [isOpen, onOpenChange])
  const opening = useRef(0)
  const restoreRef = useRef<(() => void) | null>(null)
  const open = useCallback((file: PreviewFile, message?: MessageItem, restore: () => void = () => {}) => {
    if (isRenderableImage(file.fileName, file.mimeType)) {
      openAttachmentImage(file.source, file.fileName, message ? { chatId: message.chat_id, messageId: message.id } : undefined)
      return
    }
    // App-capable hosts use App-first; iOS keeps the built-in preview without a native App host.
    if (!readOnly && !hosted && file.source.kind === 'item' && (platform.kind === 'electron' || platform.capabilities.mobileApps)) {
      void openLinkTarget({ kind: 'file', itemId: file.source.itemId }, { message, restore, fileName: file.fileName }).catch((error) => {
        if (error instanceof OpenSuperseded) return
        fileOpenLog.error({ error }, 'opening the group file failed')
        toast(downloadFailed, 'error', messageForUser(error))
      })
      return
    }
    closeRightSurfaces()
    restoreRef.current = restore ?? null
    setPreview({ file, message, opening: ++opening.current })
  }, [closeRightSurfaces, downloadFailed, hosted, toast, readOnly])
  const close = useCallback(() => {
    restoreRef.current = null
    setPreview(null)
  }, [])
  const closeByUser = useCallback(() => {
    const restore = restoreRef.current
    close()
    restore?.()
  }, [close])
  const chatNavigation = host?.chatNavigation === true
  const isTopLayer = useBackLayer(closeByUser, chatNavigation && isOpen)
  useEffect(() => {
    if (!chatNavigation || !isOpen) return
    const back = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !isTopLayer()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeByUser()
    }
    window.addEventListener('keydown', back, true)
    return () => window.removeEventListener('keydown', back, true)
  }, [chatNavigation, isOpen, isTopLayer, closeByUser])
  useEffect(() => { if (mobile && preview && !visible) close() }, [mobile, preview, visible, close])
  const body = preview && <MessageFilePreview key={preview.opening} readOnly={readOnly} fill={hosted || !mobile} onBack={chatNavigation ? closeByUser : undefined} mobile={mobile} file={preview.file} message={preview.message} onForward={readOnly ? undefined : onForward} onClose={closeByUser} />
  /** `content` with the preview beside it: on the desktop a cut whose preview comes and goes on its track (its width as the
   * side panel's was: 38% of the window, 380–520 px). */
  const beside = (content: ReactNode) => host && 'target' in host ? <>{content}{host.target && preview ? createPortal(body, host.target) : null}</> : mobile ? (
    <>{content}{preview && <Sheet fullScreenMobile onClose={closeByUser} ariaLabel={preview.file.fileName} testId="message-file-preview-sheet">{body}</Sheet>}</>
  ) : (
    <TrackCut axis="x" animate exit onShares={() => {}} onEqualize={() => {}}
      shares={(span) => { const side = Math.min(520, Math.max(380, 0.38 * window.innerWidth)); return preview ? [100 - (100 * side) / span, (100 * side) / span] : [100] }}
      items={[{ id: 'content', min: 0, node: content }, ...(preview ? [{ id: 'file-preview', min: 0, fixed: true, node: body }] : [])]} />
  )
  return { isOpen: !!preview, open, close, beside }
}
