import { useCallback, useEffect, useRef, useState } from 'react'
import { FileReadError, type FileReadState } from '@gugu/core/shared/fileReads'
import { fileBlob, FileReadRevokedError, MissingFileObjectError, shownFileBlob, type FileHandle, type FileMetadata, type FileRevision } from '@gugu/core/shared/fileResolver'
import { attachmentFileRef, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { resolveFile, requestFile, fileReader, attachmentCopyKey, cachedDisplayAttachment, forgetAttachmentCopy, putAttachment } from './fileAccess'
import { queryClient, replica } from './replica'
import { offlineHolder, type OfflineHolder } from './fileHost'
import { platform } from '../platform'
import { openImageViewer, type ImageViewerItem } from './imageViewer'
import type { ViewBox, ViewedImage } from '@/session/shared/extensions/app-runtime-protocol'
import { rendererLogger } from './log'
import { sentFileCopy, sentFileOf } from './sentFileCopies'
import { resumingCopy } from './attachmentUploads'
import { attachmentSha256 as blobSha256 } from '@gugu/core/cloud/attachmentsApi'
import { useAttachmentChange } from './attachmentChanges'
import { sessionFileReader } from './sessionFileReaders'

const log = rendererLogger('attachment-bytes')
const goneFile = { status: 'gone', sha256: null } as const

export async function resolveAttachment(source: AttachmentSource) {
  const ref = attachmentFileRef(source)
  return ref ? resolveFile(ref, fileReader()) : goneFile
}
export async function attachmentMetadata(source: AttachmentSource): Promise<FileMetadata> {
  if (source.kind === 'session-file') return { status: 'ready', revision: sessionFileRevision(source, '', 0) }
  const file = await resolveAttachment(source)
  if (file.status !== 'ready') return file
  await file.dispose()
  return { status: 'ready', revision: file.revision }
}

export async function attachmentPreview(source: AttachmentSource, metadata?: FileMetadata, signal?: AbortSignal) {
  const ref = attachmentFileRef(source)
  return ref ? resolveFile(ref, fileReader(), { purpose: 'preview', metadata, signal }) : goneFile
}
async function sessionFileBytes(source: Extract<AttachmentSource, { kind: 'session-file' }>): Promise<AttachmentBytes> {
  const read = sessionFileReader(source.sessionId)
  if (!read) throw new Error('This file is kept in its task on another view; open it from that task')
  const dataUrl = await read(source.path)
  if (!dataUrl) throw new Error('Could not read the file from its session host')
  const blob = await (await fetch(dataUrl)).blob()
  return { status: 'ready', blob, link: sessionFileRevision(source, blob.type, blob.size) }
}
function sessionFileRevision(source: Extract<AttachmentSource, { kind: 'session-file' }>, contentType: string, size: number): FileRevision {
  return { source: 'local', file_name: source.path.split(/[\\/]/).at(-1) ?? '', content_type: contentType, size_bytes: size, sha256: source.sha256 }
}
export type AttachmentVariant = 'full' | 'thumb'

/** 一个附件来源的身份(effect 的依赖):每次渲染重新解析出来的对象不同,身份相同。 */
export function sourceKeyOf(source: AttachmentSource): string {
  return source.kind === 'url' ? `url:${source.url}` : source.kind === 'item' ? `item:${source.itemId}@${source.version}` : source.kind === 'message' ? `msg:${source.messageId}` : source.kind === 'attachment' ? `attachment:${source.attachmentId}` : source.kind === 'session-file' ? `session-file:${source.sessionId ?? ''}:${source.sha256}` : 'gone'
}

/** `acknowledged`: only for 'shown' — the bytes came before the server acknowledged the read; rejecting means take them down. */
/** `pending`: its message declared it and its sender's upload is still on its way; `unsent`: that upload did not complete. */
export type AttachmentBytes = { status: 'ready'; blob: Blob; link: FileRevision; acknowledged?: Promise<void> } | { status: 'gone' | 'expired' | 'missing' | 'pending' | 'unsent' }
type ReadBytes = Exclude<AttachmentBytes, { status: 'unsent' }> | { status: 'failed' }
type AttachmentReadOptions = { signal?: AbortSignal; onState?: (state: FileReadState) => void }

/** Thumbnails only display; original blobs are created exclusively from a fully verified file handle. */
export async function attachmentBytes(source: AttachmentSource, variant: AttachmentVariant | 'shown' = 'full', onLink?: (link: FileRevision) => void, metadata?: FileMetadata, options: AttachmentReadOptions = {}): Promise<AttachmentBytes> {
  try {
    const bytes = await readAttachmentBytes(source, variant, onLink, metadata, options)
    return bytes.status === 'failed' ? { status: 'unsent' } : bytes
  } catch (error) {
    if (error instanceof MissingFileObjectError || (error instanceof FileReadError && error.cause instanceof MissingFileObjectError)) return { status: 'missing' }
    if (error instanceof FileReadError && error.code === 'upload_failed') return { status: 'unsent' }
    if (error instanceof FileReadError && (error.code === 'expired' || error.code === 'gone')) return { status: error.code }
    throw error
  }
}

async function readAttachmentBytes(source: AttachmentSource, variant: AttachmentVariant | 'shown' | 'save', onLink: ((link: FileRevision) => void) | undefined, metadata: FileMetadata | undefined, { signal, onState }: AttachmentReadOptions): Promise<ReadBytes> {
  if (source.kind === 'session-file') return sessionFileBytes(source)
  if (variant === 'thumb') {
    // A full copy already on this device (sent from here, or opened before) is the thumbnail: no signing, no download.
    const local = metadata?.status === 'ready' && metadata.revision.content_type.startsWith('image/') ? await cachedAttachmentCopy(metadata.revision.sha256) : null
    if (local && metadata?.status === 'ready') return { status: 'ready', blob: local, link: metadata.revision }
    const preview = await attachmentPreview(source, metadata, signal)
    if (preview.status !== 'ready') return preview
    try {
      onLink?.(preview.revision)
      const blob = await preview.content()
      if (!(blob instanceof Blob)) throw new Error('Expected an image preview')
      return { status: 'ready', blob, link: preview.revision }
    } finally { await preview.dispose() }
  }
  const ref = attachmentFileRef(source)
  if (!ref) return goneFile
  const file = await requestFile(ref, fileReader(), { purpose: variant === 'shown' ? 'show' : variant === 'save' ? 'save' : 'bytes', signal }, onState)
  onLink?.(file.revision)
  const { sha256 } = file.revision
  const { accountId } = file.reader
  const keep = async (blob: Blob) => {
    if (sha256 && (variant !== 'save' || !globalThis.window?.electronAPI)) await putAttachment(attachmentCopyKey(accountId, sha256), blob)
  }
  if (variant !== 'shown') { const blob = await fileBlob(file); await keep(blob); return { status: 'ready', blob, link: file.revision } }
  // A preview that can take itself down shows the bytes before the server's read acknowledgement. The plaintext is kept
  // only once acknowledged; a revoked read also removes the copy an earlier open kept.
  const { blob, acknowledged } = await shownFileBlob(file)
  // The kept copy only saves a later download: failing to write it never takes down an acknowledged read.
  return { status: 'ready', blob, link: file.revision, acknowledged: acknowledged.then(() => keep(blob).catch((error) => log.warn({ error }, 'acknowledged copy not kept')), async (error) => {
    if (sha256 && (error instanceof FileReadRevokedError || error instanceof MissingFileObjectError)) await forgetAttachmentCopy(accountId, sha256)
    throw error
  }) }
}

export type AttachmentView =
  /** link:签好了、字节还在路上(气泡按宽高先留位置)。 */
  | { status: 'loading'; link?: FileRevision }
  /** No link: the sending row's own local preview. */
  /** arrived: the bytes came while the bubble was waiting for its sender's upload (it fades them in). */
  | { status: 'ready'; objectUrl: string; link?: FileRevision; arrived?: true }
  | { status: 'gone' }
  | { status: 'expired' }
  | { status: 'missing' }
  | { status: 'failed'; holder: OfflineHolder | null }
  /** Its sender's upload is still on its way (the bubble keeps looking); unsent: it did not complete. */
  | { status: 'pending' }
  | { status: 'unsent' }

/** 缩略图在内存里只是一个 blob:记在本次运行里,超过这么久没人再取就丢。 */
const THUMB_GC_MS = 30 * 60_000
/** 内容不会变的来源:一条消息 / 一个附件 / 群文件的某一版。 */
const immutableSource = (source: AttachmentSource) => source.kind === 'message' || source.kind === 'attachment' || source.kind === 'item' || source.kind === 'session-file'

/**
 * 缩略图按来源记在读模型里(只在本次运行的内存里,不进快照)。本地缓存(Cache Storage)按内容哈希存,优先使用消息的固定版本元数据;旧行才需要先问 file-resolve:
 * 不记的话,每次重新挂载(切会话回来、120 行窗口换回来)都先等一个网络来回(实测 0.9–1.4 s 空占位)才画得出本地已有的图。
 * 不可变来源在本次运行里不再重问:被删 / 过期的文件这次运行内仍显示旧缩略图,打开原图照旧完整校验(attachmentBytes 'full')。
 */
async function sessionThumb(source: AttachmentSource, metadata?: FileMetadata): Promise<AttachmentBytes> {
  const sourceKey = sourceKeyOf(source)
  const model = immutableSource(source) ? immutableThumb : liveThumb
  const args = [sourceKey, metadata?.status === 'ready' ? metadata.revision.sha256 : metadata?.status ?? null, source, metadata ?? null] as const
  const bytes = await model.fetch(...args)
  // Bytes still on their way from the sender (or refused) are read again next time, not remembered for the run.
  const key = bytes.status === 'pending' || bytes.status === 'unsent' ? model.key(...args) : null
  if (key) queryClient.removeQueries({ queryKey: key, exact: true })
  return bytes
}

/** This device's copy of a declared attachment it is sending (this run's, or one a restart is uploading again). */
function ownPendingCopy(source: AttachmentSource, messageId: string | undefined): Blob | null {
  return sentFileCopy(source) ?? (messageId ? sentFileOf(messageId) ?? resumingCopy(messageId) : null)
}

/** A thumbnail's link (its size) arrives before its bytes: bubbles showing that source listen while they are mounted. */
const linkListeners = new Map<string, Set<(link: FileRevision) => void>>()
function listenForLink(sourceKey: string, listener: (link: FileRevision) => void): () => void {
  let set = linkListeners.get(sourceKey)
  if (!set) linkListeners.set(sourceKey, set = new Set())
  set.add(listener)
  return () => { set.delete(listener); if (!set.size) linkListeners.delete(sourceKey) }
}
const readThumb = (_accountId: string, sourceKey: string, _metadataKey: string | null, source: AttachmentSource, metadata: FileMetadata | null) =>
  attachmentBytes(source, 'thumb', (link) => linkListeners.get(sourceKey)?.forEach((listener) => listener(link)), metadata ?? undefined)
const immutableThumb = replica({ name: 'attachment-thumb', scope: 'account', read: readThumb, fresh: Infinity, keep: THUMB_GC_MS })
const liveThumb = replica({ name: 'attachment-thumb-live', scope: 'account', read: readThumb, keep: THUMB_GC_MS })

/**
 * 气泡 / 预览用:给一个 object URL;failed 时 retry() 丢掉记着的链接重新签、重新下。
 * enabled = false 时什么都不取(气泡还没滚到眼前:lazy 要推迟的是这次请求,blob URL 上的 loading="lazy" 不管用)。
 */
export function useAttachmentObjectUrl(source: AttachmentSource, variant: AttachmentVariant = 'full', enabled = true, given?: FileMetadata, messageId?: string): AttachmentView & { retry: () => void } {
  const [view, setView] = useState<AttachmentView>({ status: 'loading' })
  // Its sender's bytes arrived or were refused after the message said 'pending': what the message said no longer holds.
  const changed = useAttachmentChange(messageId)
  const metadata = changed ? undefined : given
  const [attempt, setAttempt] = useState(0)
  const owned = useRef<string | null>(null), shown = useRef(false), awaited = useRef(false)
  const sourceKey = sourceKeyOf(source)
  const metadataKey = metadata?.status === 'ready' ? metadata.revision.sha256 : metadata?.status
  // A sending row's local preview is ready from its first render; the sender owns that URL.
  const preview = source.kind === 'url' && source.url.startsWith('blob:') ? source.url : null
  useEffect(() => () => { if (owned.current) URL.revokeObjectURL(owned.current) }, [])
  useEffect(() => {
    const show = (next: AttachmentView, objectUrl: string | null = null) => {
      if (owned.current) URL.revokeObjectURL(owned.current)
      owned.current = objectUrl
      shown.current = next.status === 'ready'
      setView(next)
    }
    if (preview) { show({ status: 'ready', objectUrl: preview }); return }
    if (!enabled) return
    let alive = true
    const controller = new AbortController()
    const showBytes = async (bytes: AttachmentBytes, replacing: boolean) => {
      if (!alive) return
      if (bytes.status === 'pending') {
        // The sender draws its own copy under the ring; everyone else waits for the message's file to change (pushed).
        const own = ownPendingCopy(source, messageId)
        if (own) { const objectUrl = URL.createObjectURL(own); return show({ status: 'ready', objectUrl }, objectUrl) }
        awaited.current = true
        return show({ status: 'pending' })
      }
      if (bytes.status !== 'ready') return show({ status: bytes.status })
      const objectUrl = URL.createObjectURL(bytes.blob)
      // Pixels already on screen are swapped only once the new ones are decoded: the <img> never paints empty between them.
      if (replacing || awaited.current) await decodedImage(objectUrl)
      if (!alive) return URL.revokeObjectURL(objectUrl)
      show({ status: 'ready', objectUrl, link: bytes.link, ...(awaited.current ? { arrived: true } : {}) }, objectUrl)
    }
    if (variant === 'thumb' && metadata && metadata.status !== 'ready') {
      if (metadata.status === 'pending') void showBytes({ status: 'pending' }, false)
      else show({ status: metadata.status === 'failed' ? 'unsent' : metadata.status })
      return () => { alive = false }
    }
    // @@@keep-ready - a new source for the same attachment (a sent row's preview → its committed file) keeps the
    // pixels on screen until the new bytes are ready. A different attachment is a different component (its key).
    const replacing = shown.current
    // The placeholder stays until the bytes are decoded: no empty frame between it and the picture.
    setView((current) => current.status === 'ready' || current.status === 'pending' ? current : { status: 'loading' })
    const onLink = (link: FileRevision) => alive && setView((current) => current.status === 'ready' || current.status === 'pending' ? current : { status: 'loading', link })
    const stopListening = variant === 'thumb' ? listenForLink(sourceKey, onLink) : () => undefined
    ;(variant === 'thumb' ? sessionThumb(source, metadata) : attachmentBytes(source, variant, onLink, undefined, { signal: controller.signal })).then(
      bytes => showBytes(bytes, replacing),
      async () => {
        if (!alive) return
        const holder = source.kind === 'item' ? await offlineHolder(source.itemId, source.version) : null
        if (alive) show({ status: 'failed', holder })
      },
    )
    return () => {
      alive = false
      controller.abort()
      stopListening()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey 就是 source 的身份
  }, [sourceKey, metadataKey, variant, attempt, enabled, changed])
  const retry = useCallback(() => {
    setAttempt((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])
  if (preview) return { status: 'ready', objectUrl: preview, retry }
  return { ...view, retry }
}

function decodedImage(url: string): Promise<void> {
  const image = new Image()
  image.src = url
  return image.decode().catch(() => undefined) // An undecodable image still shows what the <img> itself makes of it.
}

/** One file in the shared viewer: the bubble's thumbnail cache first, then the verified original, each read when shown. */
function attachmentImageItem(source: AttachmentSource, fileName: string, origin?: ImageViewerItem['source']): ImageViewerItem {
  const file: NonNullable<ImageViewerItem['file']> = { name: fileName }
  const urls: string[] = []
  let released = false, preview: Promise<string> | undefined, full: Promise<string> | undefined
  const controller = new AbortController()
  const read = async (variant: AttachmentVariant) => {
    const bytes = await (variant === 'thumb' ? sessionThumb(source) : attachmentBytes(source, 'full', undefined, undefined, { signal: controller.signal }))
    if (bytes.status !== 'ready') throw new Error(bytes.status)
    file.contentType = bytes.link.content_type
    // The record's size reaches the viewer with the first pixels, so the thumbnail is laid out as the original.
    const { width, height } = bytes.link
    if (!item.size && width && height) item.size = { width, height }
    const url = URL.createObjectURL(bytes.blob)
    if (released) URL.revokeObjectURL(url); else urls.push(url)
    return url
  }
  const item: ImageViewerItem = {
    url: '', alt: fileName, file, source: origin,
    preview: () => preview ??= read('thumb'), full: () => full ??= read('full'),
    release: () => { released = true; controller.abort(); urls.splice(0).forEach(url => URL.revokeObjectURL(url)) },
    resource: source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: source.itemId, version: source.version } } : undefined,
  }
  return item
}

/** Open the shared viewer now; use the bubble's thumbnail cache and verified lazy original. */
export function openAttachmentImage(source: AttachmentSource, fileName: string, origin?: ImageViewerItem['source']): void {
  openImageViewer([attachmentImageItem(source, fileName, origin)])
}

/** How long the viewer waits for the clicked image's thumbnail (and so its size), to open from it rather than empty. */
export const VIEWER_THUMB_WAIT_MS = 120

/**
 * Chat images opened from a page that shows several (an App's `among`): the viewer pages through them from `index`. The
 * clicked one's thumbnail is waited for a moment, so the viewer opens from `box` (its picture on the window) with its
 * pixels and size; without them it fades in, and they follow.
 */
export function openAttachmentImages(images: readonly ViewedImage[], index: number, origin?: ImageViewerItem['source'], box?: ViewBox): Promise<void> {
  return openViewerFromClick(images.map((image) => attachmentImageItem({ kind: 'item', itemId: image.itemId, version: image.version }, image.name, origin)), index, box)
}

/** Images a page showed, opened from the clicked one's picture (`box`, on the window) once its first pixels are here — or soon. */
export async function openViewerFromClick(items: ImageViewerItem[], index: number, box?: ViewBox): Promise<void> {
  const clicked = items[index]
  if (!clicked?.preview) throw new Error('The clicked image is not among the images to open')
  if (box) clicked.thumbRect = box
  const thumb = await Promise.race([clicked.preview().catch(() => null), new Promise<null>((done) => setTimeout(done, VIEWER_THUMB_WAIT_MS, null))])
  if (thumb) clicked.url = thumb
  // Its first pixels are the original (a working copy's): their size is the one to open at.
  if (thumb && !clicked.size && !clicked.full) {
    const image = new Image()
    image.src = thumb
    await image.decode().catch(() => undefined)
    if (image.naturalWidth && image.naturalHeight) clicked.size = { width: image.naturalWidth, height: image.naturalHeight }
  }
  openImageViewer(items, index)
}

/** A working copy's image in the shared viewer: its bytes read when shown (`read`), its size from them. */
export function workingCopyImageItem(name: string, read: () => Promise<Blob>): ImageViewerItem {
  const urls: string[] = []
  let released = false, bytes: Promise<string> | undefined
  return {
    url: '', alt: name, file: { name },
    preview: () => bytes ??= read().then((blob) => {
      const url = URL.createObjectURL(blob)
      if (released) URL.revokeObjectURL(url); else urls.push(url)
      return url
    }),
    release: () => { released = true; urls.splice(0).forEach(url => URL.revokeObjectURL(url)) },
  }
}

/** A download is an explicit waiter, including while the sender is still uploading. */
export async function downloadAttachment(source: AttachmentSource, fileName: string, options: AttachmentReadOptions = {}): Promise<void> {
  const bytes = await readAttachmentBytes(source, 'save', undefined, undefined, options)
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  options.signal?.throwIfAborted()
  const { downloadBlob } = await import('./download')
  options.signal?.throwIfAborted()
  await downloadBlob(bytes.blob, fileName)
}

/** Only the original capability can cross the system-open boundary. */
export async function openAttachmentInSystemApp(source: AttachmentSource, fileName: string, { signal, onState }: AttachmentReadOptions = {}): Promise<void> {
  if (!platform.capabilities.externalFileOpen) throw new Error('External file open is unavailable on this platform')
  const ref = attachmentFileRef(source)
  if (!ref) throw new Error('gone')
  const file = await requestFile(ref, fileReader(), { purpose: 'save', signal }, onState)
  await openFileHandle(file, fileName)
}
export const openFileHandle = (file: FileHandle, fileName: string) => platform.openRemoteFile(file, fileName)

/** Reads only an existing full-size local copy; never signs or downloads. ACL is checked by the caller. */
export async function cachedAttachmentCopy(sha256: string | null): Promise<Blob | null> {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null
  return cachedDisplayAttachment(fileReader().accountId, sha256)
}

/** A file this device sends is a full local copy of what it commits: kept by its sha256, read back by cachedAttachmentCopy. */
export async function keepSentAttachment(file: Blob, sha256?: string): Promise<void> {
  await putAttachment(attachmentCopyKey(fileReader().accountId, sha256 ?? await blobSha256(file)), file)
}
