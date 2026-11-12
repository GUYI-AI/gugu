import { useContext, useEffect, useMemo, useRef, type CSSProperties, type RefObject } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { parseAttachmentContent, type ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import { isRenderableImage } from '@gugu/core/shared/imageMime.mjs'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { attachmentBytes, sourceKeyOf, useAttachmentObjectUrl } from '../../lib/attachmentBytes'
import { openImageFromThumb, registerFullImage } from '../../lib/imageViewer'
import { sentFileCopy } from '../../lib/sentFileCopies'
import { Markdown } from '../markdown/Markdown'
import { layoutAlbum } from './albumLayout'
import { MediaAttachmentBubble } from './MediaAttachmentBubble'
import { useNearViewport } from './useNearViewport'
import { SentMessageSurface } from './sentMessageSurface'

// #2581 One send drawn as one message, after Telegram's albums: the images tiled together, the other files under them,
// the text last. Each file is still its own row: a file that did not go up is marked on its own tile or card.

/** Tiles are laid out on this width and drawn in proportion, so the album narrows with its column like one image does. */
const ALBUM_WIDTH = 280
const ALBUM_STYLE: CSSProperties = { position: 'relative', width: `min(${ALBUM_WIDTH}px, calc(100cqw - 24px))`, maxWidth: '100%' }

type Part = { member: MessageItem; meta: ParsedAttachment }

export function MessageAlbumBubble({ members, isMine, chatId, senderName, onOpenFile }: {
  members: readonly MessageItem[]
  isMine: boolean
  chatId: string
  senderName?: string
  onOpenFile?: (meta: ParsedAttachment, message: MessageItem) => void
}) {
  const parts = useMemo(() => members.flatMap((member): Part[] => {
    const meta = parseAttachmentContent(member.content, member)
    return meta ? [{ member, meta }] : []
  }), [members])
  // An image is tiled while its bytes can still be drawn; one this device sent but no longer holds is a card like a file.
  const tiled = parts.filter(({ meta }) => isRenderableImage(meta.fileName, meta.mimeType) && meta.source.kind !== 'gone'
    && !(meta.source.kind === 'url' && meta.source.url.startsWith('blob:') && !sentFileCopy(meta.source)))
  const listed = parts.filter(part => !tiled.includes(part))
  const caption = parts.findLast(({ meta }) => meta.caption)?.meta.caption
  return <div className="flex max-w-full flex-col items-start gap-1" data-message-album={members.length}>
    {tiled.length > 0 && <AlbumTiles parts={tiled} chatId={chatId} />}
    {listed.map(({ member, meta }) => <div key={member.id} className="relative max-w-full" data-album-failed={member.local_send_state === 'failed' || undefined}>
      <MediaAttachmentBubble meta={{ ...meta, caption: undefined }} messageId={member.id} isMine={isMine} chatId={chatId} senderName={senderName}
        onOpenFile={onOpenFile ? (file) => onOpenFile(file, member) : undefined} />
      {member.local_send_state === 'failed' && <FailedMark style={{ position: 'absolute', top: 6, right: 6 }} />}
    </div>)}
    {caption && <Markdown trust="chat" content={caption} onAccent={isMine} />}
  </div>
}

function AlbumTiles({ parts, chatId }: { parts: Part[]; chatId: string }) {
  const layout = useMemo(() => layoutAlbum(parts.map(({ member, meta }) => {
    const size = meta.fileMetadata?.status === 'ready' ? meta.fileMetadata.revision : meta.imageDimensions ?? member.image_dimensions
    return size?.width && size.height ? size.width / size.height : 1
  }), ALBUM_WIDTH), [parts])
  const percent = (value: number, of: number) => `${(value / of) * 100}%`
  return <div style={{ ...ALBUM_STYLE, aspectRatio: `${layout.width} / ${layout.height}` }} data-testid="message-album-tiles">
    {parts.map((part, index) => {
      const tile = layout.tiles[index]!
      return <AlbumTile key={part.member.id} part={part} chatId={chatId} style={{
        position: 'absolute', left: percent(tile.x, layout.width), top: percent(tile.y, layout.height),
        width: percent(tile.width, layout.width), height: percent(tile.height, layout.height),
      }} />
    })}
  </div>
}

function AlbumTile({ part: { member, meta }, chatId, style }: { part: Part; chatId: string; style: CSSProperties }) {
  const box = useRef<HTMLElement>(null)
  // A sending row draws from its local preview at once; others are fetched once they come near the screen.
  const onMount = useContext(SentMessageSurface)
  const near = useNearViewport(box, !onMount) || onMount
  const view = useAttachmentObjectUrl(meta.source, 'thumb', near, meta.fileMetadata)
  const img = useRef<HTMLImageElement>(null)
  const ready = view.status === 'ready'
  const sourceKey = sourceKeyOf(meta.source)
  const size = meta.fileMetadata?.status === 'ready' ? meta.fileMetadata.revision : undefined
  // The viewer opens on the thumbnail and swaps in the original when it reaches this image (same as one image).
  useEffect(() => {
    if (!ready || !img.current || meta.source.kind === 'url') return
    let full: Promise<string> | null = null
    const unregister = registerFullImage(img.current, () => (full ??= attachmentBytes(meta.source, 'full').then((bytes) => {
      if (bytes.status !== 'ready') throw new Error('attachment is gone')
      return URL.createObjectURL(bytes.blob)
    })), meta.source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: meta.source.itemId, version: meta.source.version } } : undefined,
    { name: meta.fileName, contentType: meta.mimeType }, { chatId, messageId: member.id },
    size?.width && size.height ? { width: size.width, height: size.height } : undefined)
    return () => {
      unregister()
      void full?.then((url) => URL.revokeObjectURL(url), () => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey 就是 meta.source 的身份
  }, [ready, sourceKey, meta.fileName, meta.mimeType, chatId, member.id, size?.width, size?.height])
  const failed = member.local_send_state === 'failed'
  return <div ref={box as RefObject<HTMLDivElement>} data-album-failed={failed || undefined}
    style={{ ...style, overflow: 'hidden', background: 'var(--muted)' }}>
    <button type="button" aria-label={meta.fileName} disabled={!ready} onClick={() => img.current && openImageFromThumb(img.current)}
      className={`relative block size-full border-0 bg-transparent p-0 ${ready ? 'cursor-zoom-in' : 'cursor-default'}`}>
      {ready && <img ref={img} src={view.objectUrl} data-image-viewer-src={view.objectUrl} alt={meta.fileName}
        data-testid={AUTOMATION_TEST_IDS.messageAttachmentImage} draggable={false}
        decoding={view.link ? 'async' : 'sync'} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />}
      {failed && <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgb(0 0 0 / 0.36)' }}><FailedMark /></span>}
    </button>
  </div>
}

/** The failed-send glyph of FailedSendStatus, filled, on top of the file that did not go up. */
function FailedMark({ style }: { style?: CSSProperties }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" style={style}>
    <circle cx="12" cy="12" r="11" fill="var(--danger)" />
    <path d="M12 6.5v6.5" stroke="var(--surface-white)" strokeWidth="2.2" strokeLinecap="round" />
    <circle cx="12" cy="17" r="1.3" fill="var(--surface-white)" />
  </svg>
}
