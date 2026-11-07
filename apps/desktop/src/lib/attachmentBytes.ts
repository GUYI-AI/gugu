import { useCallback, useEffect, useRef, useState } from 'react'
import { fileBlob, FileReadRevokedError, MissingFileObjectError, shownFileBlob, type FileHandle, type FileMetadata, type FileRevision } from '@gugu/core/shared/fileResolver'
import { fileSha256 } from '@gugu/core/shared/fileCipher'
import { attachmentFileRef, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { resolveFile, fileReader, fileReadSignal, attachmentCache, attachmentCacheOrigin } from './fileAccess'
import { attachmentQuery, attachmentQueryClient } from './attachmentQueryClient'
import { platform } from '../platform'
import { openImageViewer, type ImageViewerItem } from './imageViewer'
import { rendererLogger } from './log'

const log = rendererLogger('attachment-bytes')

/** `showFirst`: the bytes before the read acknowledgement, for a reader that can take them down. `progress`: how far they have come. */
export async function resolveAttachment(source: AttachmentSource, options: { showFirst?: true; progress?: (done: number, total: number) => void } = {}) {
  const ref = attachmentFileRef(source)
  return ref ? resolveFile(ref, fileReader(), { signal: fileReadSignal(), ...options }) : { status: 'gone' as const, sha256: null }
}
export async function attachmentMetadata(source: AttachmentSource): Promise<FileMetadata> {
  const file = await resolveAttachment(source)
  if (file.status !== 'ready') return file
  await file.dispose(); return { status: 'ready', revision: file.revision }
}
export async function attachmentPreview(source: AttachmentSource, metadata?: FileMetadata) {
  const ref = attachmentFileRef(source)
  return ref ? resolveFile(ref, fileReader(), { purpose: 'preview', metadata, signal: fileReadSignal() }) : { status: 'gone' as const, sha256: null }
}
const fullKey = (accountId: string, sha: string) => `${attachmentCacheOrigin}/account/${encodeURIComponent(accountId)}/sha256/${sha}`

export type AttachmentVariant = 'full' | 'thumb'

/** 一个附件来源的身份(effect 的依赖):每次渲染重新解析出来的对象不同,身份相同。 */
export function sourceKeyOf(source: AttachmentSource): string {
  return source.kind === 'url' ? `url:${source.url}` : source.kind === 'item' ? `item:${source.itemId}@${source.version}` : source.kind === 'message' ? `msg:${source.messageId}` : source.kind === 'attachment' ? `attachment:${source.attachmentId}` : 'gone'
}

/** `acknowledged`: only for 'shown' — the bytes came before the server acknowledged the read; rejecting means take them down. */
export type AttachmentBytes = { status: 'ready'; blob: Blob; link: FileRevision; acknowledged?: Promise<void> } | { status: 'gone' | 'expired' | 'missing' }

/** Thumbnails only display; original blobs are created exclusively from a fully verified file handle. */
/** `progress`: how far the original's bytes have come, while they are read (the file preview's bar). */
export async function attachmentBytes(source: AttachmentSource, variant: AttachmentVariant | 'shown' = 'full', onLink?: (link: FileRevision) => void, metadata?: FileMetadata, progress?: (done: number, total: number) => void): Promise<AttachmentBytes> {
  try { return await readAttachmentBytes(source, variant, onLink, metadata, progress) }
  catch (error) { if (error instanceof MissingFileObjectError) return { status: 'missing' }; throw error }
}

async function readAttachmentBytes(source: AttachmentSource, variant: AttachmentVariant | 'shown', onLink?: (link: FileRevision) => void, metadata?: FileMetadata, progress?: (done: number, total: number) => void): Promise<AttachmentBytes> {
  if (variant === 'thumb') {
    // A full copy already on this device (sent from here, or opened before) is the thumbnail: no signing, no download.
    const local = metadata?.status === 'ready' && metadata.revision.content_type.startsWith('image/') ? await cachedAttachmentCopy(metadata.revision.sha256) : null
    if (local && metadata?.status === 'ready') return { status: 'ready', blob: local, link: metadata.revision }
    const preview = await attachmentPreview(source, metadata)
    if (preview.status !== 'ready') return preview
    try {
      onLink?.(preview.revision)
      const blob = await preview.content()
      if (!(blob instanceof Blob)) throw new Error('Expected an image preview')
      return { status: 'ready', blob, link: preview.revision }
    } finally { await preview.dispose() }
  }
  const file = await resolveAttachment(source, { ...(variant === 'shown' ? { showFirst: true as const } : {}), ...(progress ? { progress } : {}) })
  if (file.status !== 'ready') return file
  onLink?.(file.revision)
  const key = file.revision.sha256 === null ? null : fullKey(file.reader.accountId, file.revision.sha256)
  const keep = async (blob: Blob) => { if (key) await (await attachmentCache()).put(key, new Response(blob)) }
  if (variant !== 'shown') { const blob = await fileBlob(file); await keep(blob); return { status: 'ready', blob, link: file.revision } }
  // A preview that can take itself down shows the bytes before the server's read acknowledgement. The plaintext is kept
  // only once acknowledged; a revoked read also removes the copy an earlier open kept.
  const { blob, acknowledged } = await shownFileBlob(file)
  // The kept copy only saves a later download: failing to write it never takes down an acknowledged read.
  return { status: 'ready', blob, link: file.revision, acknowledged: acknowledged.then(() => keep(blob).catch((error) => log.warn({ error }, 'acknowledged copy not kept')), async (error) => {
    if (key && (error instanceof FileReadRevokedError || error instanceof MissingFileObjectError)) await (await attachmentCache()).delete(key)
    throw error
  }) }
}

export type AttachmentView =
  /** link:签好了、字节还在路上(气泡按宽高先留位置)。 */
  | { status: 'loading'; link?: FileRevision }
  /** No link: the sending row's own local preview. */
  | { status: 'ready'; objectUrl: string; link?: FileRevision }
  | { status: 'gone' }
  | { status: 'expired' }
  | { status: 'missing' }
  | { status: 'failed' }

/** 缩略图在内存里只是一个 blob:记在本次运行里,超过这么久没人再取就丢。 */
const THUMB_GC_MS = 30 * 60_000
/** 内容不会变的来源:一条消息 / 一个附件 / 群文件的某一版。 */
const immutableSource = (source: AttachmentSource) => source.kind === 'message' || source.kind === 'attachment' || source.kind === 'item'

/**
 * 缩略图按来源记在 attachmentQueryClient 里。本地缓存(Cache Storage)按内容哈希存,优先使用消息的固定版本元数据;旧行才需要先问 file-resolve:
 * 不记的话,每次重新挂载(切会话回来、120 行窗口换回来)都先等一个网络来回(实测 0.9–1.4 s 空占位)才画得出本地已有的图。
 * 不可变来源在本次运行里不再重问:被删 / 过期的文件这次运行内仍显示旧缩略图,打开原图照旧完整校验(attachmentBytes 'full')。
 */
async function sessionThumb(source: AttachmentSource, metadata?: FileMetadata): Promise<AttachmentBytes> {
  const sourceKey = sourceKeyOf(source)
  return attachmentQueryClient.fetchQuery({
    ...thumbQuery(fileReader().accountId, sourceKey, metadata?.status === 'ready' ? metadata.revision.sha256 : metadata?.status ?? null, source, metadata ?? null),
    staleTime: immutableSource(source) ? Infinity : 0,
    gcTime: THUMB_GC_MS,
  })
}
/** A thumbnail's link (its size) arrives before its bytes: bubbles showing that source listen while they are mounted. */
const linkListeners = new Map<string, Set<(link: FileRevision) => void>>()
function listenForLink(sourceKey: string, listener: (link: FileRevision) => void): () => void {
  let set = linkListeners.get(sourceKey)
  if (!set) linkListeners.set(sourceKey, set = new Set())
  set.add(listener)
  return () => { set.delete(listener); if (!set.size) linkListeners.delete(sourceKey) }
}
const thumbQuery = attachmentQuery('attachment-thumb', (_accountId: string, sourceKey: string, _metadataKey: string | null,
  source: AttachmentSource, metadata: FileMetadata | null) =>
  attachmentBytes(source, 'thumb', (link) => linkListeners.get(sourceKey)?.forEach((listener) => listener(link)), metadata ?? undefined))

/**
 * 气泡 / 预览用:给一个 object URL;failed 时 retry() 丢掉记着的链接重新签、重新下。
 * enabled = false 时什么都不取(气泡还没滚到眼前:lazy 要推迟的是这次请求,blob URL 上的 loading="lazy" 不管用)。
 */
export function useAttachmentObjectUrl(source: AttachmentSource, variant: AttachmentVariant = 'full', enabled = true, metadata?: FileMetadata): AttachmentView & { retry: () => void } {
  const [view, setView] = useState<AttachmentView>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const owned = useRef<string | null>(null), shown = useRef(false)
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
    if (variant === 'thumb' && metadata && metadata.status !== 'ready') { show({ status: metadata.status }); return }
    let alive = true
    // @@@keep-ready - a new source for the same attachment (a sent row's preview → its committed file) keeps the
    // pixels on screen until the new bytes are ready. A different attachment is a different component (its key).
    const replacing = shown.current
    setView((current) => current.status === 'ready' ? current : { status: 'loading' })
    const onLink = (link: FileRevision) => alive && setView((current) => current.status === 'ready' ? current : { status: 'loading', link })
    const stopListening = variant === 'thumb' ? listenForLink(sourceKey, onLink) : () => undefined
    ;(variant === 'thumb' ? sessionThumb(source, metadata) : attachmentBytes(source, variant, onLink)).then(
      async (bytes) => {
        if (!alive) return
        if (bytes.status !== 'ready') return show({ status: bytes.status })
        const objectUrl = URL.createObjectURL(bytes.blob)
        // Pixels already on screen are swapped only once the new ones are decoded: the <img> never paints empty between them.
        if (replacing) await decodedImage(objectUrl)
        if (!alive) return URL.revokeObjectURL(objectUrl)
        show({ status: 'ready', objectUrl, link: bytes.link }, objectUrl)
      },
      () => alive && show({ status: 'failed' }),
    )
    return () => {
      alive = false
      stopListening()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey 就是 source 的身份
  }, [sourceKey, metadataKey, variant, attempt, enabled])
  const retry = useCallback(() => {
    setAttempt((n) => n + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])
  if (preview) return { status: 'ready', objectUrl: preview, retry }
  return variant === 'thumb' && metadata && metadata.status !== 'ready' ? { status: metadata.status, retry } : { ...view, retry }
}

function decodedImage(url: string): Promise<void> {
  const image = new Image()
  image.src = url
  return image.decode().catch(() => undefined) // An undecodable image still shows what the <img> itself makes of it.
}

/** Open the shared viewer now; use the bubble's thumbnail cache and verified lazy original. */
export function openAttachmentImage(source: AttachmentSource, fileName: string, origin?: ImageViewerItem['source']): void {
  const file: NonNullable<ImageViewerItem['file']> = { name: fileName }
  const urls: string[] = []
  let released = false, preview: Promise<string> | undefined, full: Promise<string> | undefined
  const read = async (variant: AttachmentVariant) => {
    const bytes = await (variant === 'thumb' ? sessionThumb(source) : attachmentBytes(source, 'full'))
    if (bytes.status !== 'ready') throw new Error(bytes.status)
    file.contentType = bytes.link.content_type
    const url = URL.createObjectURL(bytes.blob)
    if (released) URL.revokeObjectURL(url); else urls.push(url)
    return url
  }
  openImageViewer([{
    url: '', alt: fileName, file, source: origin,
    preview: () => preview ??= read('thumb'), full: () => full ??= read('full'),
    release: () => { released = true; urls.splice(0).forEach(url => URL.revokeObjectURL(url)) },
    resource: source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: source.itemId, version: source.version } } : undefined,
  }])
}

/** 下载一个附件(同一份缓存);条目删了就抛。 */
export async function downloadAttachment(source: AttachmentSource, fileName: string): Promise<void> {
  const bytes = await attachmentBytes(source)
  if (bytes.status !== 'ready') throw new Error(bytes.status)
  const { downloadBlob } = await import('./download')
  await downloadBlob(bytes.blob, fileName)
}

/** Only the original capability can cross the system-open boundary. */
export async function openAttachmentInSystemApp(source: AttachmentSource, fileName: string): Promise<void> {
  if (!platform.capabilities.externalFileOpen) throw new Error('External file open is unavailable on this platform')
  const file = await resolveAttachment(source)
  if (file.status !== 'ready') throw new Error(file.status)
  await openFileHandle(file, fileName)
}
export const openFileHandle = (file: FileHandle, fileName: string) => platform.openRemoteFile(file, fileName)

/** Reads only an existing full-size local copy; never signs or downloads. ACL is checked by the caller. */
export async function cachedAttachmentCopy(sha256: string | null): Promise<Blob | null> {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null
  const hit = await (await attachmentCache()).match(fullKey(fileReader().accountId, sha256))
  if (!hit) return null
  const blob = await hit.blob()
  return await blobSha256(blob) === sha256 ? blob : null
}

/** A file this device sends is a full local copy of what it commits: kept by its sha256, read back by cachedAttachmentCopy. */
export async function keepSentAttachment(file: Blob): Promise<void> {
  await (await attachmentCache()).put(fullKey(fileReader().accountId, await blobSha256(file)), new Response(file))
}

async function blobSha256(blob: Blob): Promise<string> {
  const hash = fileSha256.create(), reader = blob.stream().getReader()
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; hash.update(chunk.value) }
  return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('')
}
