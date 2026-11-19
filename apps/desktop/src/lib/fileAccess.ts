import { cloudFileProviders } from '@gugu/core/cloud/fileProviders'
import { createFileMetadataLoader } from '@gugu/core/cloud/fileMetadata'
import { attachmentRequest, attachmentSha256 } from '@gugu/core/cloud/attachmentsApi'
import { getSupabaseUrl } from '@gugu/core/cloud/config'
import { anySignal } from '@gugu/core/shared/anySignal'
import { createCachedFileSink, type FileChunkCache } from '@gugu/core/shared/fileCache'
import { createFileReads, FileReadError, type FileReadOptions, type FileReadState } from '@gugu/core/shared/fileReads'
import { fileRefKey, FileReadRevokedError, MissingFileObjectError, snapshotBlob, requireFileRange, FILE_CHUNK_BYTES, type FileActor, type FileContext, type FileHandle, type FileMetadata, type FileRef, type FileRevision, type ResolvedFile, type ResolvedPreview } from '@gugu/core/shared/fileResolver'
import type { NativeFileReadCommand, NativeFileReadIpc } from '../../electron/nativeFileHost'
import { attachmentsEndpoint } from './attachmentsEndpoint'
import { budgetedCacheWriter } from './attachmentCacheBudget'
import { rendererLogger } from './log'
import { getRendererSession, observeRendererSession } from './sessionPublication'
import { subscribeAttachmentChanges } from './attachmentChanges'

export const attachmentCache = () => caches.open('gugu-attachments-v1')
export const attachmentCacheOrigin = 'https://attachments.gugu.invalid'
const log = rendererLogger('attachments')
export const ATTACHMENT_CACHE_BYTES = 10 * 1024 ** 3
const CHUNK_PREFIX = `${attachmentCacheOrigin}/chunks/`
/** 续传分片带写入时刻:一天内的是读到一半的(不计入、不删,别的窗口也可能正在读),更早的是崩溃留下的(删)。 */
const CHUNK_WRITTEN_AT = 'x-gugu-written-at'
const CHUNK_ORPHAN_MS = 24 * 60 * 60_000
const attachmentWriter = budgetedCacheWriter(attachmentCache, ATTACHMENT_CACHE_BYTES,
  (url, response) => !url.startsWith(CHUNK_PREFIX) ? 'budget'
    : Date.now() - Number(response.headers.get(CHUNK_WRITTEN_AT) ?? 0) < CHUNK_ORPHAN_MS ? 'keep' : 'drop',
  (error) => log.warn({ error }, 'attachment cache trim failed'))
/** 写进附件缓存的唯一入口(打开的原图、预览、发送时留的本机副本)。 */
export const putAttachment = attachmentWriter.put
const legacyFullKey = (accountId: string, sha: string) => `${attachmentCacheOrigin}/account/${encodeURIComponent(accountId)}/sha256/${sha}`
export const attachmentCopyKey = (accountId: string, sha: string, backend = getSupabaseUrl()) =>
  `${attachmentCacheOrigin}/backend/${encodeURIComponent(backend)}/account/${encodeURIComponent(accountId)}/sha256/${sha}`
export async function readCachedAttachment(key: string, sha: string): Promise<Blob | null> {
  const hit = await (await attachmentCache()).match(key)
  if (!hit) return null
  const blob = await hit.blob()
  return await attachmentSha256(blob) === sha ? blob : null
}

/** Old copies can still supply display pixels and a sender's resumable upload. */
export async function cachedDisplayAttachment(accountId: string, sha: string): Promise<Blob | null> {
  return await readCachedAttachment(attachmentCopyKey(accountId, sha), sha)
    ?? await readCachedAttachment(legacyFullKey(accountId, sha), sha)
}

export async function forgetAttachmentCopy(accountId: string, sha: string) {
  const cache = await attachmentCache()
  await Promise.all([cache.delete(attachmentCopyKey(accountId, sha)), cache.delete(legacyFullKey(accountId, sha))])
}
let account = getRendererSession()?.user.id, generation = new AbortController()
observeRendererSession(({ session }) => {
  if (session?.user.id === account) return
  generation.abort(new Error('File reader account changed')); generation = new AbortController(); account = session?.user.id
})
export function fileReader(as?: string | null) {
  const accountId = getRendererSession()?.user.id
  if (!accountId) throw new Error('File reader is not signed in')
  return { accountId, actorId: as ?? accountId }
}
export const fileReadSignal = () => generation.signal
const endpoint = async (context: FileContext) => {
  context.signal?.throwIfAborted()
  if (context.actor.accountId !== fileReader().accountId) throw new Error('File reader account changed')
  return attachmentsEndpoint()
}
const key = (id: string, index: number) => `${CHUNK_PREFIX}${id}/${index}`
const chunks: FileChunkCache = {
  async get(id, index) { const hit = await (await attachmentCache()).match(key(id, index)); return hit ? new Uint8Array(await hit.arrayBuffer()) : null },
  async put(id, index, bytes) { requireFileRange(FILE_CHUNK_BYTES, 0, bytes.length); await (await attachmentCache()).put(key(id, index), new Response(new Uint8Array(bytes), { headers: { [CHUNK_WRITTEN_AT]: String(Date.now()) } })) },
  async clear(id) { const cache = await attachmentCache(); await Promise.all((await cache.keys()).filter(request => request.url.startsWith(`${attachmentCacheOrigin}/chunks/${id}/`)).map(request => cache.delete(request))) },
}
const metadata = createFileMetadataLoader(async (context, refs) => attachmentRequest(await endpoint(context), 'file-resolve', { refs, as: context.actor.actorId }, context.signal))
async function imageThumbnail(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas'), scale = Math.min(1, 560 / bitmap.width)
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d'); if (!context) throw new Error('Image preview is unavailable')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image preview is unavailable')), 'image/webp'))
  } finally { bitmap.close() }
}

function createBrowserFileAccess() {
  const cloud = cloudFileProviders({ endpoint, metadata, cache: chunks, sink: async size => createCachedFileSink(chunks, size),
    imageCache: { match: async request => (await attachmentCache()).match(request), put: async (request, response) => putAttachment(request, await response.blob()) },
    image: async (file, revision) => imageThumbnail(await snapshotBlob(file, revision.content_type)),
  })
  const reads = createFileReads({ ...cloud, local: async () => null, ssh: async () => null }, {
    async cachedCopy(backend, revision, { actor, signal }) {
      if (!revision.sha256) return null
      const blob = await readCachedAttachment(attachmentCopyKey(actor.accountId, revision.sha256, backend), revision.sha256)
      signal?.throwIfAborted()
      if (!blob || blob.size !== revision.size_bytes) return null
      return { size: blob.size, async read(offset, length) {
        requireFileRange(blob.size, offset, length)
        return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
      }, async dispose() {} }
    },
  })
  return { reads, metadata: cloud.metadata }
}
let browserAccess: ReturnType<typeof createBrowserFileAccess> | undefined
const browser = () => browserAccess ??= createBrowserFileAccess()

function restoreNativeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const boundary = '\ngugu-file-error '
  const at = error.message.lastIndexOf(boundary)
  if (at === -1) return error
  try {
    const detail = JSON.parse(error.message.slice(at + boundary.length)) as
      | { kind: 'revoked'; reason: FileReadRevokedError['reason'] }
      | { kind: 'missing' }
      | { kind: 'failed'; code: FileReadError['code'] }
    if (detail.kind === 'missing') return new MissingFileObjectError()
    if (detail.kind === 'revoked') return new FileReadRevokedError(detail.reason)
    if (detail.kind === 'failed') return new FileReadError(detail.code, error.message.slice(0, at))
  } catch (parseError) { log.warn({ error: parseError }, 'invalid native file error') }
  return error
}

function nativeCall<C extends NativeFileReadCommand>(electron: NativeFileReadIpc, command: C) {
  return electron.fileRead(command).catch((error: unknown) => { throw restoreNativeError(error) })
}

type ReadCommand = Exclude<NativeFileReadCommand, { op: 'nudge' }>
type ReadOperation<T = ReadCommand> = T extends ReadCommand ? Omit<T, 'actor' | 'ref' | 'id'> : never

function nativeReader(electron: NativeFileReadIpc, ref: FileRef, actor: FileActor, signal: AbortSignal, onState?: (state: FileReadState) => void) {
  signal.throwIfAborted()
  const identity = { id: crypto.randomUUID(), ref: { ...ref }, actor: { ...actor } }
  const off = onState && electron.onFileReadState(({ id, state }) => { if (id === identity.id && !signal.aborted) onState(state) })
  const abort = () => { void close('cancel').catch((error) => log.warn({ error }, 'native file cancellation failed')) }
  let closed: Promise<void> | undefined
  function close(op: 'cancel' | 'dispose') {
    if (closed) return closed
    signal.removeEventListener('abort', abort)
    off?.()
    return closed = nativeCall(electron, { ...identity, op })
  }
  signal.addEventListener('abort', abort, { once: true })
  const check = () => {
    signal.throwIfAborted()
    if (closed) throw new Error('File handle is disposed')
  }
  const call = async <const C extends ReadOperation>(command: C) => {
    check()
    const scoped = { ...identity, ...command } as ReadCommand & { op: C['op'] }
    const result = await nativeCall(electron, scoped)
    check()
    return result
  }
  return { call, check, dispose: () => close('dispose') }
}

function nativeFileHandle(reader: ReturnType<typeof nativeReader>, actor: FileActor, revision: FileRevision, showFirst?: true): FileHandle {
  const read = async (offset: number, length: number) => {
    requireFileRange(revision.size_bytes, offset, length)
    const bytes = new Uint8Array(await reader.call({ op: 'read', offset, length }))
    if (bytes.byteLength !== length) throw new Error('File snapshot length changed')
    return bytes
  }
  const acknowledgement = () => reader.call({ op: 'ack' })
  return { status: 'ready', purpose: 'file', reader: actor, revision, read, acknowledgement, dispose: reader.dispose,
    async *stream() {
      reader.check()
      if (!revision.size_bytes && !showFirst) await acknowledgement()
      for (let offset = 0; offset < revision.size_bytes; offset += FILE_CHUNK_BYTES) yield await read(offset, Math.min(FILE_CHUNK_BYTES, revision.size_bytes - offset))
      reader.check()
    },
  }
}

export async function requestFile(ref: FileRef, actor: FileActor, options: FileReadOptions, onState?: (state: FileReadState) => void): Promise<FileHandle> {
  const signal = anySignal([fileReadSignal(), options.signal])
  const electron = globalThis.window?.electronAPI
  if (!electron) {
    const request = browser().reads.request(ref, actor, { ...options, signal })
    const off = onState && request.state$(onState)
    try { return (await request.result).file } finally { off?.() }
  }
  const reader = nativeReader(electron, ref, actor, signal, onState)
  try {
    const { revision } = await reader.call({ op: 'request', purpose: options.purpose, ...(options.admit ? { admit: options.admit } : {}) })
    return nativeFileHandle(reader, actor, revision, options.purpose === 'show' ? true : undefined)
  } catch (error) {
    await reader.dispose().catch((failure) => log.warn({ error: failure }, 'native file disposal failed'))
    throw error
  }
}

export function resolveFile(ref: FileRef, actor: FileActor, options: { localOnly: true; signal?: AbortSignal }): Promise<ResolvedFile | null>
export function resolveFile(ref: FileRef, actor: FileActor, options: { purpose: 'preview'; metadata?: FileMetadata; signal?: AbortSignal }): Promise<ResolvedPreview>
export function resolveFile(ref: FileRef, actor: FileActor, options?: { signal?: AbortSignal }): Promise<ResolvedFile>
export async function resolveFile(ref: FileRef, actor: FileActor, options: { purpose?: 'preview'; metadata?: FileMetadata; localOnly?: true; signal?: AbortSignal } = {}): Promise<ResolvedFile | ResolvedPreview | null> {
  const electron = globalThis.window?.electronAPI
  const { purpose, metadata, localOnly } = options
  const signal = anySignal([fileReadSignal(), options.signal])
  if (!electron) {
    if (purpose === 'preview') return browser().reads.resolve(ref, actor, { purpose, metadata, signal })
    return localOnly ? null : browser().reads.resolve(ref, actor, { signal })
  }
  if (purpose === 'preview' && metadata && metadata.status !== 'ready') return metadata
  if (purpose === 'preview' && metadata?.status === 'ready' && 'item_id' in ref &&
    (metadata.revision.item_id !== ref.item_id || ref.version !== undefined && metadata.revision.version !== ref.version)) {
    throw new Error('File preview reference changed')
  }
  const reader = nativeReader(electron, ref, actor, signal)
  try {
    const file = await reader.call({ op: 'resolve', purpose, localOnly })
    if (file?.status !== 'ready') { await reader.dispose(); return file }
    if (purpose !== 'preview') return nativeFileHandle(reader, actor, file.revision)
    const { revision } = file
    const image = revision.content_type.startsWith('image/')
    const key = revision.source === 'managed-object' && image && revision.sha256
      ? `${attachmentCacheOrigin}/preview/${encodeURIComponent(JSON.stringify([getSupabaseUrl(), actor, fileRefKey(ref), revision.sha256]))}` : null
    const content = async () => {
      if (key) {
        const hit = await (await attachmentCache()).match(key)
        reader.check()
        if (hit) return hit.blob()
      }
      const preview = await reader.call({ op: 'preview' })
      if ('url' in preview) return preview
      const blob = 'bytes' in preview ? new Blob([new Uint8Array(preview.bytes)], { type: preview.type }) : await snapshotBlob({
        size: preview.size,
        read: (offset, length) => reader.call({ op: 'read', offset, length }),
        dispose: reader.dispose,
      }, preview.type)
      if (revision.source === 'local' && image) return imageThumbnail(blob)
      if (key && 'bytes' in preview) await putAttachment(key, blob)
      return blob
    }
    let thumbnail: ReturnType<typeof content> | undefined
    return { ...file, purpose, dispose: reader.dispose, async content() {
      reader.check()
      return image ? thumbnail ??= content() : content()
    } }
  } catch (error) {
    await reader.dispose().catch((failure) => log.warn({ error: failure }, 'native file disposal failed'))
    throw error
  }
}

subscribeAttachmentChanges(() => {
  const electron = globalThis.window?.electronAPI
  if (electron) void nativeCall(electron, { op: 'nudge' }).catch((error) => log.warn({ error }, 'native file nudge failed'))
  else browserAccess?.reads.nudge()
})

/** Where a chat file's bytes are kept, from the same metadata batch the resolver reads: no bytes, no transfer. */
export async function metadataForFile(ref: FileRef, actor: FileActor): Promise<FileMetadata> {
  const signal = fileReadSignal(), electron = globalThis.window?.electronAPI
  if (!electron) return browser().metadata({ ref, actor, signal })
  signal.throwIfAborted()
  const result = await nativeCall(electron, { op: 'metadata', id: crypto.randomUUID(), ref, actor })
  signal.throwIfAborted()
  return result
}
export const fileMetadata = (itemId: string, version?: number) => metadataForFile(version === undefined ? { item_id: itemId } : { item_id: itemId, version }, fileReader())

/** The UI's placement and recent-open tracking share the resolver's no-network local probe. */
export async function localFileRevision(itemId: string): Promise<FileRevision | null> {
  if (!globalThis.window?.electronAPI) return null
  const file = await resolveFile({ item_id: itemId }, fileReader(), { localOnly: true, signal: fileReadSignal() })
  if (file?.status !== 'ready') return null
  try { return file.revision } finally { await file.dispose() }
}
