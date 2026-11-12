import { useContext, useEffect, useRef, type RefObject, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { holderOfflineText, useHolderBack } from '../../lib/fileHost'
import { attachmentBytes, attachmentMetadata, sourceKeyOf, useAttachmentObjectUrl } from '../../lib/attachmentBytes'
import { sentFileCopy } from '../../lib/sentFileCopies'
import { useAuth } from '../../store/auth'
import { attachmentQuery, attachmentQueryClient } from '../../lib/attachmentQueryClient'
import { ExtensionBundleCard } from '../extensionBundle/ExtensionBundleCard'; import { isExtensionBundle } from '../extensionBundle/summarizeExtensionBundle'
import { openImageFromThumb, registerFullImage } from '../../lib/imageViewer'
import { Button } from '../ui/Button'
import { FileAttachmentCard } from './FileAttachmentCard'
import { SentMessageSurface } from './sentMessageSurface'
import { useNearViewport } from './useNearViewport'
import { ExpiredAttachmentCard } from './ExpiredAttachmentCard'
import { Markdown } from '../markdown/Markdown'
import './mediaAttachmentBubble.css'

// @@@fit-bubble 气泡正文是 align-items:flex-start 的 flex 列,子项按内容宽取 fit-content;文件名不换行,卡片的最小内容宽顶到 260px,
// 而气泡被封顶在列宽 → 窄栏下卡片从气泡右侧冒出。max-width:100% 在布局阶段按气泡内容区截回来(卡片里的文件名随之省略)。
const FIT_BUBBLE = 'max-w-full'

/** Whether an attachment is still there (missing / expired / gone cards). Key: account, source key, source. */
const attachmentStateQuery = attachmentQuery('attachment-state',
  (_accountId: string | undefined, _sourceKey: string, source: ParsedAttachment['source']) => attachmentMetadata(source))

/** 与 .chat-inline-image 的上限一致:按宽高先留出画出来的那么大。 */
const INLINE_MAX = 280

// @@@inline-image-decision - 画不画成图只看「浏览器能不能画」(mime ∪ 扩展名,shared/imageMime.mjs),
// 不看写进正文的 [Kind]:历史上 agent 不带 mime_type 发的 PNG 被记成 file,这里让它们自愈。
// 字节一律经 lib/attachmentBytes(签名链接 + Cache Storage);临时故障由共享读取层静默重试,
// 条目删了说「文件已删除」。
export function MediaAttachmentBubble({ meta, messageId, isMine, onOpenFile, senderName, chatId, onDownload }: { meta: ParsedAttachment; messageId: string; isMine: boolean; onOpenFile?: (meta: ParsedAttachment) => void; senderName?: string; chatId?: string; onDownload?: () => void }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const box = useRef<HTMLDivElement>(null)
  const managedFile = (meta.source.kind === 'item' || meta.source.kind === 'message' || meta.source.kind === 'attachment') && !isRenderableImage(meta.fileName, meta.mimeType)
  const near = useNearViewport(box, managedFile)
  const metadata = useQuery({ ...attachmentStateQuery(user?.id, sourceKeyOf(meta.source), meta.source),
    enabled: near && !!user && managedFile,
  }, attachmentQueryClient)
  const caption = meta.caption ? <Markdown trust="chat" content={meta.caption} onAccent={isMine} /> : null
  if (metadata.data?.status === 'missing') return <div ref={box} className={FIT_BUBBLE} data-attachment-unavailable><FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileMissing')} />{caption}</div>
  if (metadata.data?.status === 'expired') return <div ref={box} className={FIT_BUBBLE} data-attachment-unavailable><ExpiredAttachmentCard meta={meta} messageId={messageId} isMine={isMine} />{caption}</div>
  if (metadata.data?.status === 'gone' || metadata.isError) return <div ref={box} className={FIT_BUBBLE} data-attachment-unavailable><FileAttachmentCard file={meta} isMine={isMine}
    details={t(metadata.isError ? 'attachmentView.fileUnavailable' : 'attachmentView.fileGone')} />{caption}</div>
  const renderable = isRenderableImage(meta.fileName, meta.mimeType)
  // A row not delivered yet reads the file this device sent, while it uploads and if it failed. A preview this run did not
  // make (a row restored after a restart) has no bytes behind it any more.
  if (meta.source.kind === 'url' && meta.source.url.startsWith('blob:')) {
    if (!sentFileCopy(meta.source)) return <div ref={box} className={FIT_BUBBLE} data-attachment-unavailable><FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileUnavailable')} />{caption}</div>
    if (!renderable) return <div ref={box} className={FIT_BUBBLE}><FileAttachmentCard file={meta} isMine={isMine} onOpen={() => onOpenFile?.(meta)} />{caption}</div>
  }
  // App 包:按这条消息装(发布者就是发送者,装的时候由宿主读这条消息)。
  if (isExtensionBundle(meta) && meta.source.kind !== 'gone' && meta.source.kind !== 'attachment' && meta.source.kind !== 'session-file') return <div ref={box} className={FIT_BUBBLE}><ExtensionBundleCard meta={meta} card={{ source: meta.source, messageId }} isMine={isMine} senderName={senderName} chatId={chatId} />{caption}</div>
  if (meta.source.kind === 'gone') {
    return <div className={FIT_BUBBLE}><FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileGone')} onOpen={() => undefined} />{caption}</div>
  }
  // One image stays one InlineImage from sending to committed (its folder name may still change); another attachment is another one.
  if (renderable) return <div ref={box} className={FIT_BUBBLE}><InlineImage key={`${messageId}:${meta.sizeBytes}`} meta={meta} messageId={messageId} chatId={chatId} isMine={isMine} />{caption}</div>
  // Pin the group file version; the first version does not need a label.
  const versionLabel = meta.source.kind === 'item' && meta.source.version > 1 ? t('attachmentView.fileVersion', { n: meta.source.version }) : undefined
  return <div ref={box} className={FIT_BUBBLE}><FileAttachmentCard file={meta} isMine={isMine} versionLabel={versionLabel} onOpen={() => onOpenFile?.(meta)} onDownload={onDownload} downloadLabel={t('chatArea.filePreview.download')} />{caption}</div>
}

function InlineImage({ meta, messageId, chatId, isMine }: { meta: ParsedAttachment; messageId: string; chatId?: string; isMine: boolean }) {
  const { t } = useTranslation('messaging')
  // Observed in either state: a sending row is drawn from its local preview without ever being pending.
  const box = useRef<HTMLElement>(null)
  const onMount = useContext(SentMessageSurface)
  const near = useNearViewport(box, !onMount) || onMount
  const view = useAttachmentObjectUrl(meta.source, 'thumb', near, meta.fileMetadata)
  const img = useRef<HTMLImageElement>(null)
  const holder = view.status === 'failed' ? view.holder : null
  useHolderBack(holder, view.retry)
  const dimensions = meta.fileMetadata?.status === 'ready' ? meta.fileMetadata.revision : meta.imageDimensions ?? ('link' in view ? view.link : undefined)
  const size = originalSize(dimensions)
  const imageStyle = inlineImageStyle(size)
  const ready = view.status === 'ready'
  const sourceKey = sourceKeyOf(meta.source)
  // 查看器:先拿缩略图打开,翻到这一张再取原图(同一份缓存);卸载时收回 object URL。
  useEffect(() => {
    if (!ready || !img.current || meta.source.kind === 'url') return
    let full: Promise<string> | null = null
    const unregister = registerFullImage(img.current, () => (full ??= attachmentBytes(meta.source, 'full').then((bytes) => {
      if (bytes.status !== 'ready') throw new Error('attachment is gone')
      return URL.createObjectURL(bytes.blob)
    })), meta.source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: meta.source.itemId, version: meta.source.version } } : undefined, { name: meta.fileName, contentType: meta.mimeType }, chatId ? { chatId, messageId } : undefined, size)
    return () => {
      unregister()
      void full?.then((url) => URL.revokeObjectURL(url), () => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey 就是 meta.source 的身份
  }, [ready, sourceKey, meta.fileName, meta.mimeType, chatId, messageId, size?.width, size?.height])

  if (view.status === 'gone') return <span className="contents" data-attachment-unavailable><FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileGone')} onOpen={() => undefined} /></span>
  if (view.status === 'missing') return <FileAttachmentCard file={meta} isMine={isMine} details={t('attachmentView.fileMissing')} />
  if (view.status === 'expired') return <span className="contents" data-attachment-unavailable><ExpiredAttachmentCard meta={meta} messageId={messageId} isMine={isMine} /></span>
  if (view.status === 'failed') {
    return (
      <FileAttachmentCard
        file={meta}
        isMine={isMine}
        details={holder ? holderOfflineText(holder) : t('attachmentView.imageUnavailable')}
      />
    )
  }
  if (view.status === 'ready') {
    return (
      <Button ref={box as RefObject<HTMLButtonElement>} variant="ghost" size="icon" onClick={(e) => openImageFromThumb(e.currentTarget.querySelector('img') as HTMLImageElement)} style={{ display: 'block', width: 'auto', minHeight: 0, padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', ...imageStyle, ...(imageStyle ? { position: 'relative' } : {}) }}>
        <img
          ref={img}
          data-testid={AUTOMATION_TEST_IDS.messageAttachmentImage} data-image-viewer-src={view.objectUrl}
          src={view.objectUrl}
          alt={meta.fileName}
          className="chat-inline-image"
          style={imageStyle ? { position: 'absolute', inset: 0, width: '100%', height: '100%' } : undefined}
          // The sending row's own preview paints with its bubble (as before); fetched thumbnails decode off the main thread.
          decoding={view.link ? 'async' : 'sync'}
        />
      </Button>
    )
  }
  return <div ref={box as RefObject<HTMLDivElement>} aria-label={meta.fileName} className="chat-inline-image chat-inline-image--pending" style={imageStyle} />
}

/** The file record's pixel size, which the viewer lays the image out by (its thumbnail is smaller). */
function originalSize(dimensions?: { width?: number | null; height?: number | null }): { width: number; height: number } | undefined {
  const { width, height } = dimensions ?? {}
  return typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : undefined
}

function fitInline(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, INLINE_MAX / width, INLINE_MAX / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}


/** Sending, loading and decoded pixels keep the same fitted box, including narrow columns. */
function inlineImageStyle(size?: { width: number; height: number }): CSSProperties | undefined {
  if (!size) return undefined
  const fitted = fitInline(size.width, size.height)
  return { width: fitted.width, height: 'auto', aspectRatio: `${fitted.width} / ${fitted.height}`, maxWidth: 'min(100%, calc(100cqw - 24px))' }
}

