import { useCallback, useEffect, useRef, useState } from 'react'
import { fileBlob, FileReadRevokedError, MissingFileObjectError, shownFileBlob, requireFileRevision, type FileHandle, type FileMetadata, type FileProgress, type FileRevision } from '@gugu/core/shared/fileResolver'
import { attachmentFileRef, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { resolveFile, fileReader, fileReadSignal, attachmentCache, attachmentCacheOrigin, putAttachment, nativeLocalBytes } from './fileAccess'
import { onAccountChange, replica } from './replica'
import { offlineHolder, type OfflineHolder } from './fileHost'
import { platform } from '../platform'
import { openImageViewer, registerFullImage, type ImageViewerItem, type Size } from './imageViewer'
import type { ViewBox, ViewedImage } from '@/session/shared/extensions/app-runtime-protocol'
import { rendererLogger } from './log'
import { sentFileCopy, sentFileOf } from './sentFileCopies'
import { resumingCopy } from './attachmentUploads'
import { attachmentSha256 as blobSha256 } from '@gugu/core/cloud/attachmentsApi'
import { useAttachmentChange } from './attachmentChanges'
import { sessionFileReader } from './sessionFileReaders'
import { createImageRead } from './imageRead'

const log = rendererLogger('attachment-bytes')

/** `showFirst`: the bytes before the read acknowledgement, for a reader that can take them down. `progress`: how far they have come. */
export async function resolveAttachment(source: AttachmentSource, options: { showFirst?: true; progress?: FileProgress } = {}) {
  const ref = attachmentFileRef(source)
  const file = ref ? await resolveFile(ref, fileReader(), { signal: fileReadSignal(), ...options }) : { status: 'gone' as const, sha256: null }
  if (file.status === 'ready') void rememberVersion(source, file.revision)
  return file
}

/**
 * @@@local-first - Which version an immutable source is (a message's file, an attachment, a chat-folder version) is learned
 * from its first resolve and remembered beside the bytes, in this account's Cache Storage: opening it again finds that
 * version's bytes on this machine (this run's preview read, this machine's disk, the kept copy) without asking the server.
 * Only bytes that are not here are authorized and fetched: a file withdrawn, or a member removed, is refused then; bytes
 * already here cannot be taken back by refusing to show them.
 */
const versionKey = (accountId: string, sourceKey: string) => `${attachmentCacheOrigin}/account/${encodeURIComponent(accountId)}/source/${encodeURIComponent(sourceKey)}`
const versions = new Map<string, FileRevision>()
onAccountChange(() => versions.clear())
function versionKeysOf(source: AttachmentSource, revision: FileRevision): string[] {
  const keys = [sourceKeyOf(source)]
  if (revision.item_id && revision.version !== undefined) keys.push(sourceKeyOf({ kind: 'item', itemId: revision.item_id, version: revision.version }))
  return [...new Set(keys)]
}
/** In memory from its resolve (a preview opened during the read joins it); beside the bytes (`persist`) once they are here. */
async function rememberVersion(source: AttachmentSource, revision: FileRevision, persist = false) {
  if (!immutableSource(source) || source.kind === 'session-file' || !revision.sha256) return
  const accountId = fileReader().accountId
  for (const sourceKey of versionKeysOf(source, revision)) {
    const key = versionKey(accountId, sourceKey)
    versions.set(key, revision)
    if (persist) await putAttachment(key, new Blob([JSON.stringify(revision)], { type: 'application/json' }))
  }
}
async function knownVersion(source: AttachmentSource): Promise<FileRevision | null> {
  if (!immutableSource(source) || source.kind === 'session-file') return null
  const key = versionKey(fileReader().accountId, sourceKeyOf(source))
  const remembered = versions.get(key)
  if (remembered) return remembered
  const hit = await (await attachmentCache()).match(key)
  if (!hit) return null
  try {
    const revision = JSON.parse(await (await hit.blob()).text()) as FileRevision
    requireFileRevision(revision)
    if (!revision.sha256) return null
    versions.set(key, revision)
    return revision
  } catch (error) { log.warn({ error }, 'remembered file version unreadable'); return null }
}
export async function attachmentMetadata(source: AttachmentSource): Promise<FileMetadata> {
  if (source.kind === 'session-file') return { status: 'ready', revision: sessionFileRevision(source, '', 0) }
  const file = await resolveAttachment(source)
  if (file.status !== 'ready') return file
  await file.dispose(); return { status: 'ready', revision: file.revision }
}

export async function attachmentPreview(source: AttachmentSource, metadata?: FileMetadata) {
  const ref = attachmentFileRef(source)
  return ref ? resolveFile(ref, fileReader(), { purpose: 'preview', metadata, signal: fileReadSignal() }) : { status: 'gone' as const, sha256: null }
}
async function sessionFileBytes(source: Extract<AttachmentSource, { kind: 'session-file' }>): Promise<AttachmentBytes> {
  const read = sessionFileReader(source.sessionId)
  if (!read) throw new Error('This file is kept in its task on another view; open it from that task')
  const blob = await read(source.path)
  return { status: 'ready', blob, link: sessionFileRevision(source, blob.type, blob.size) }
}
function sessionFileRevision(source: Extract<AttachmentSource, { kind: 'session-file' }>, contentType: string, size: number): FileRevision {
  return { source: 'local', file_name: source.path.split(/[\\/]/).at(-1) ?? '', content_type: contentType, size_bytes: size, sha256: source.sha256 }
}
const fullKey = (accountId: string, sha: string) => `${attachmentCacheOrigin}/account/${encodeURIComponent(accountId)}/sha256/${sha}`

export type AttachmentVariant = 'full' | 'thumb'

/** 一个附件来源的身份(effect 的依赖):每次渲染重新解析出来的对象不同,身份相同。 */
export function sourceKeyOf(source: AttachmentSource): string {
  return source.kind === 'url' ? `url:${source.url}` : source.kind === 'item' ? `item:${source.itemId}@${source.version}` : source.kind === 'message' ? `msg:${source.messageId}` : source.kind === 'attachment' ? `attachment:${source.attachmentId}` : source.kind === 'session-file' ? `session-file:${JSON.stringify([source.sessionId, source.path, source.sha256])}` : 'gone'
}

/** `acknowledged`: only for 'shown' — the bytes came before the server acknowledged the read; rejecting means take them down. */
/** `pending`: its message declared it and its sender's upload is still on its way; `unsent`: that upload did not complete. */
/** `expired` with `thumb`: a thumbnail read of an image whose original expired, its sender's preview. */
export type AttachmentBytes = { status: 'ready'; blob: Blob; link: FileRevision; acknowledged?: Promise<void> } | { status: 'gone' | 'missing' | 'pending' | 'unsent' } | { status: 'expired'; thumb?: Blob }
type ReadBytes = Exclude<AttachmentBytes, { status: 'unsent' }> | { status: 'failed' }

/** Thumbnails only display; original blobs are created exclusively from a fully verified file handle. */
/** `progress`: how far the original's bytes have come, while they are read (the file preview's bar). */
export async function attachmentBytes(source: AttachmentSource, variant: AttachmentVariant | 'shown' = 'full', onLink?: (link: FileRevision) => void, metadata?: FileMetadata, progress?: FileProgress): Promise<AttachmentBytes> {
  try { const bytes = await readAttachmentBytes(source, variant, onLink, metadata, progress); return bytes.status === 'failed' ? { status: 'unsent' } : bytes }
  catch (error) { if (error instanceof MissingFileObjectError) return { status: 'missing' }; throw error }
}

async function readAttachmentBytes(source: AttachmentSource, variant: AttachmentVariant | 'shown', onLink?: (link: FileRevision) => void, metadata?: FileMetadata, progress?: FileProgress): Promise<ReadBytes> {
  if (source.kind === 'session-file') return sessionFileBytes(source)
  if (variant === 'thumb') {
    // A full copy already on this device (sent from here, or opened before) is the thumbnail: no signing, no download.
    const local = metadata?.status === 'ready' ? await localAttachmentCopy(metadata.revision.sha256, metadata.revision.content_type) : null
    if (local && metadata?.status === 'ready') return { status: 'ready', blob: local, link: metadata.revision }
    const preview = await attachmentPreview(source, metadata)
    if (preview.status === 'expired') return preview.content ? { status: 'expired', thumb: await preview.content() } : { status: 'expired' }
    if (preview.status !== 'ready') return preview
    try {
      onLink?.(preview.revision)
      const blob = await preview.content()
      if (!(blob instanceof Blob)) throw new Error('Expected an image preview')
      return { status: 'ready', blob, link: preview.revision }
    } finally { await preview.dispose() }
  }
  // @@@local-first: the bytes of a version already here are shown without asking the server; only what is not here is
  // authorized (resolve) and fetched.
  const known = await knownVersion(source)
  const here = known ? await bytesHere(known, variant, progress) : null
  if (here) return here
  // A preview's progress is also told to previews of the same version that join this read (shownReads).
  let key: string | null = null
  const told: FileProgress | undefined = variant === 'shown' ? (...at) => { progress?.(...at); if (key) shownProgress.tell(key, ...at) } : progress
  const file = await resolveAttachment(source, { ...(variant === 'shown' ? { showFirst: true as const } : {}), ...(told ? { progress: told } : {}) })
  if (file.status !== 'ready') return file
  onLink?.(file.revision)
  key = file.revision.sha256 === null ? null : fullKey(file.reader.accountId, file.revision.sha256)
  // A version this machine had not heard of may still be here (sent from here, kept by an open before it was remembered),
  // or a preview of it may have begun reading since.
  const found = await bytesHere(file.revision, variant, progress)
  if (found) {
    await file.dispose()
    await rememberVersion(source, file.revision, true).catch((error) => log.warn({ error }, 'file version not remembered'))
    return found
  }
  // Only bytes that came over the network are kept: one read from this machine's own disk is already here. Either way the
  // version is remembered beside them, so the next opening finds them without asking.
  const keep = async (blob: Blob) => {
    if (!key) return
    try {
      if (!await file.fromDisk?.()) await putAttachment(key, blob)
      await rememberVersion(source, file.revision, true)
    } catch (error) { log.warn({ error }, 'authorized copy not kept') }
  }
  if (variant !== 'shown') { const blob = await fileBlob(file); await keep(blob); return { status: 'ready', blob, link: file.revision } }
  // A preview that can take itself down shows the bytes before the server's read acknowledgement. The plaintext is kept
  // only once acknowledged; a revoked read also removes the copy an earlier open kept.
  const read = shownFileBlob(file).then(({ blob, acknowledged }) => ({ blob,
    // The kept copy only saves a later download: failing to write it never takes down an acknowledged read.
    acknowledged: acknowledged.then(() => keep(blob).catch((error) => log.warn({ error }, 'acknowledged copy not kept')), async (error) => {
      if (key && (error instanceof FileReadRevokedError || error instanceof MissingFileObjectError)) await (await attachmentCache()).delete(key)
      throw error
    }) }))
  if (key) holdShown(key, read)
  const { blob, acknowledged } = await read
  return { status: 'ready', blob, link: file.revision, acknowledged }
}

/**
 * This version's bytes on this machine, if they are here: a preview's read of it in this run (finished, or on its way:
 * joined with its progress), else this machine's disk or the copy an earlier open kept (localAttachmentCopy).
 */
async function bytesHere(revision: FileRevision, variant: AttachmentVariant | 'shown', progress?: FileProgress): Promise<ReadBytes | null> {
  if (!revision.sha256) return null
  const key = fullKey(fileReader().accountId, revision.sha256)
  const held = variant === 'shown' ? shownReads.get(key) : undefined
  if (held) {
    const stop = progress ? shownProgress.listen(key, progress) : () => undefined
    try {
      const { blob, acknowledged } = await held.read
      touchShown(key)
      return { status: 'ready', blob, link: revision, acknowledged }
    } finally { stop() }
  }
  const blob = await localAttachmentCopy(revision.sha256, revision.content_type)
  return blob ? { status: 'ready', blob, link: revision } : null
}

/**
 * A preview's bytes of a version, by account and sha: a preview of that version mounted
 * again (its group left and come back to, its tab out of the retained window) shows them without moving or hashing 10 MB
 * again, and one mounted while they are on their way joins that read and its progress — ❌ a second read from the start.
 * At most SHOWN_KEEP_BYTES are kept, least recently opened dropped first (Cache Storage still has them); a read that fails,
 * or whose acknowledgement does, is dropped.
 */
export const SHOWN_KEEP_BYTES = 32 * 1024 ** 2
type ShownRead = { blob: Blob; acknowledged: Promise<void> }
const shownReads = new Map<string, { read: Promise<ShownRead>; size?: number }>()
const shownProgress = listeners<Parameters<FileProgress>>()
onAccountChange(() => shownReads.clear())
function holdShown(key: string, read: Promise<ShownRead>) {
  const entry: { read: Promise<ShownRead>; size?: number } = { read }
  shownReads.set(key, entry)
  const drop = () => { if (shownReads.get(key) === entry) shownReads.delete(key) }
  read.then(({ blob, acknowledged }) => {
    acknowledged.catch(drop)
    if (shownReads.get(key) !== entry) return
    entry.size = blob.size
    touchShown(key)
  }, drop)
}
/** The most recently opened last; past SHOWN_KEEP_BYTES the oldest read ones go (a read on its way stays). */
function touchShown(key: string) {
  const entry = shownReads.get(key)
  if (!entry) return
  shownReads.delete(key)
  shownReads.set(key, entry)
  let total = 0
  for (const { size } of shownReads.values()) total += size ?? 0
  for (const [held, { size }] of shownReads) {
    if (total <= SHOWN_KEEP_BYTES) break
    if (size === undefined) continue
    shownReads.delete(held)
    total -= size
  }
}

export type AttachmentView =
  /** link:签好了、字节还在路上(气泡按宽高先留位置)。 */
  | { status: 'loading'; link?: FileRevision }
  /** No link: the sending row's own local preview. */
  /** arrived: the bytes came while the bubble was waiting for its sender's upload (it fades them in). */
  | { status: 'ready'; objectUrl: string; link?: FileRevision; arrived?: true }
  | { status: 'gone' }
  /** objectUrl: its preview, which outlived the original. */
  | { status: 'expired'; objectUrl?: string }
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
  if (bytes.status === 'pending' || bytes.status === 'unsent') await model.reset(...args)
  return bytes
}

/** This device's copy of a declared attachment it is sending (this run's, or one a restart is uploading again). */
function ownPendingCopy(source: AttachmentSource, messageId: string | undefined): Blob | null {
  return sentFileCopy(source) ?? (messageId ? sentFileOf(messageId) ?? resumingCopy(messageId) : null)
}

/**
 * What a read says while it is on its way (a thumbnail's link, a preview's progress) goes to every surface showing that
 * source or version, each listening while it is mounted: the read itself is shared by all of them.
 */
function listeners<T extends unknown[]>() {
  const sets = new Map<string, Set<(...args: T) => void>>()
  return {
    listen(key: string, listener: (...args: T) => void): () => void {
      let set = sets.get(key)
      if (!set) sets.set(key, set = new Set())
      set.add(listener)
      return () => { set.delete(listener); if (!set.size) sets.delete(key) }
    },
    tell(key: string, ...args: T) { sets.get(key)?.forEach((listener) => listener(...args)) },
  }
}
/** A thumbnail's link (its size) arrives before its bytes. */
const linkListeners = listeners<[FileRevision]>()
const readThumb = (_accountId: string, sourceKey: string, _metadataKey: string | null, source: AttachmentSource, metadata: FileMetadata | null) =>
  attachmentBytes(source, 'thumb', (link) => linkListeners.tell(sourceKey, link), metadata ?? undefined)
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
  const previousSource = useRef<{ key: string; messageId?: string } | null>(null)
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
    const previous = previousSource.current
    const sameAttachment = previous?.key === sourceKey || !!messageId && previous?.messageId === messageId
    previousSource.current = { key: sourceKey, messageId }
    if (!sameAttachment) {
      awaited.current = false
      show({ status: 'loading' })
    }
    if (preview) { show({ status: 'ready', objectUrl: preview }); return }
    if (!enabled) return
    let alive = true
    const showBytes = async (bytes: AttachmentBytes, replacing: boolean) => {
      if (!alive) return
      if (bytes.status === 'pending') {
        // The sender draws its own copy under the ring; everyone else waits for the message's file to change (pushed).
        const own = ownPendingCopy(source, messageId)
        if (own) { const objectUrl = URL.createObjectURL(own); return show({ status: 'ready', objectUrl }, objectUrl) }
        awaited.current = true
        return show({ status: 'pending' })
      }
      if (bytes.status === 'expired' && bytes.thumb) { const objectUrl = URL.createObjectURL(bytes.thumb); return show({ status: 'expired', objectUrl }, objectUrl) }
      if (bytes.status !== 'ready') return show({ status: bytes.status })
      const objectUrl = URL.createObjectURL(bytes.blob)
      // Pixels already on screen are swapped only once the new ones are decoded: the <img> never paints empty between them.
      if (replacing || awaited.current) await decodedImage(objectUrl)
      if (!alive) return URL.revokeObjectURL(objectUrl)
      show({ status: 'ready', objectUrl, link: bytes.link, ...(awaited.current ? { arrived: true } : {}) }, objectUrl)
    }
    if (variant === 'thumb' && metadata && metadata.status !== 'ready' && metadata.status !== 'expired') {
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
    const stopListening = variant === 'thumb' ? linkListeners.listen(sourceKey, onLink) : () => undefined
    ;(variant === 'thumb' ? sessionThumb(source, metadata) : attachmentBytes(source, variant, onLink)).then(
      bytes => showBytes(bytes, replacing),
      async () => {
        const holder = source.kind === 'item' ? await offlineHolder(source.itemId, source.version) : null
        if (alive) show({ status: 'failed', holder })
      },
    )
    return () => {
      alive = false
      stopListening()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey 就是 source 的身份
  }, [sourceKey, metadataKey, messageId, variant, attempt, enabled, changed])
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
  const readers = new Map<AttachmentVariant, ReturnType<typeof createImageRead>>()
  const read = async (variant: AttachmentVariant) => {
    const bytes = await (variant === 'thumb' ? sessionThumb(source) : attachmentBytes(source, 'full'))
    if (bytes.status !== 'ready') throw new Error(bytes.status)
    file.contentType = bytes.link.content_type
    // The record's size reaches the viewer with the first pixels, so the thumbnail is laid out as the original.
    const { width, height } = bytes.link
    if (!item.size && width && height) item.size = { width, height }
    return bytes.blob
  }
  for (const variant of ['thumb', 'full'] as const) readers.set(variant, createImageRead(() => read(variant)))
  const item: ImageViewerItem = {
    url: '', alt: fileName, file, source: origin,
    preview: () => readers.get('thumb')!.load(), full: () => readers.get('full')!.load(),
    release: () => { for (const reader of readers.values()) reader.release() },
    resource: source.kind === 'item' ? { kind: 'file', target: { kind: 'file', itemId: source.itemId, version: source.version } } : undefined,
  }
  return item
}

/** Open the shared viewer now; use the bubble's thumbnail cache and verified lazy original. */
export function openAttachmentImage(source: AttachmentSource, fileName: string, origin?: ImageViewerItem['source']): void {
  openImageViewer([attachmentImageItem(source, fileName, origin)])
}

/** A mounted bubble lends a retryable original reader and owns the URLs until it unmounts. */
export function registerAttachmentImage(thumb: HTMLImageElement, source: AttachmentSource, file: NonNullable<ImageViewerItem['file']>,
  origin?: ImageViewerItem['source'], size?: Size): () => void {
  const reader = createImageRead(async () => {
    const bytes = await attachmentBytes(source, 'full')
    if (bytes.status !== 'ready') throw new Error(bytes.status)
    return bytes.blob
  })
  const resource = source.kind === 'item' ? { kind: 'file' as const, target: { kind: 'file' as const, itemId: source.itemId, version: source.version } } : undefined
  const unregister = registerFullImage(thumb, reader.load, resource, file, origin, size)
  return () => { unregister(); reader.release() }
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
  const reader = createImageRead(read)
  return {
    url: '', alt: name, file: { name },
    preview: reader.load,
    release: reader.release,
  }
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

/**
 * The one way to this machine's bytes of a sha: what the desktop holds on disk (its file store, or an original it sent,
 * checked against the sha), else what this renderer kept of bytes it read over the network. Never signs or downloads; ACL
 * is checked by the caller.
 */
export async function localAttachmentCopy(sha256: string | null, contentType = ''): Promise<Blob | null> {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null
  const native = await nativeLocalBytes(sha256, contentType)
  if (native) try { return await native.blob() } finally { await native.release() }
  return keptAttachmentCopy(sha256, contentType)
}

/** The same bytes as an address a `<video>` reads in ranges: main's own, or a URL of what this renderer kept. */
export async function localAttachmentUrl(sha256: string | null, contentType = ''): Promise<{ url: string; release(): Promise<void> } | null> {
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null
  const native = await nativeLocalBytes(sha256, contentType)
  if (native) return native
  const kept = await keptAttachmentCopy(sha256, contentType)
  if (!kept) return null
  const url = URL.createObjectURL(kept)
  return { url, release: async () => URL.revokeObjectURL(url) }
}

async function keptAttachmentCopy(sha256: string, contentType: string): Promise<Blob | null> {
  const hit = await (await attachmentCache()).match(fullKey(fileReader().accountId, sha256))
  if (!hit) return null
  const blob = await hit.blob()
  return await blobSha256(blob) === sha256 ? blob.slice(0, blob.size, contentType || blob.type) : null
}

/** Where there is no main process (the phone, the web), the bytes a device sends are kept here, read back by localAttachmentCopy. */
export async function keepSentAttachment(file: Blob, sha256?: string): Promise<void> {
  await putAttachment(fullKey(fileReader().accountId, sha256 ?? await blobSha256(file)), file)
}
