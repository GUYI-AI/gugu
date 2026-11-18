import { sha256 } from '@noble/hashes/sha2.js'
import { copyVerifiedFile, ciphertextSize, transformFile, type FileSink } from '../shared/fileCipher'
import { FILE_CHUNK_BYTES, FileReadRevokedError, MissingFileObjectError, fileRefKey, requireFileRange, parseFileMetadata, snapshotBlob, type FileBytes, type FileContext, type FileMetadata, type FileProviders, type FileRevision } from '../shared/fileResolver'
import type { FileChunkCache } from '../shared/fileCache'
import { AttachmentsError, attachmentRequest, type AttachmentsEndpoint } from './attachmentsApi'
import { withBoundedOperation } from './boundedOperation'
import { FileReadError, createSenderWaits } from '../shared/fileReads'
import { anySignal } from '../shared/anySignal'
import { isTransientFileReadError, retryFileDownload } from './fileDownloadRetry'
import { createFileDownloadTransport, fileDownloadSession, type FileDownloadSession } from './fileDownloadRouting'
import { readFileThumbnail } from './fileThumbnailDownload'

/** How long bytes shown before their read acknowledgement may stay up while it is pending. */
const ACKNOWLEDGEMENT_MS = 15_000

export type { FileChunkCache } from '../shared/fileCache'
type Download = { status: string; code?: string; url: string; expires_at?: string; origin_available?: boolean; thumb_url?: string | null; download_id: string; key?: string; codec?: string; sha256: string | null; size_bytes: number; ciphertext_bytes?: number; ciphertext_sha256?: string; bucket_id?: string; object_name?: string; message_id?: string }
type SignedDownload = { lease: Download; direct: boolean }
const missingObject = (row: { status: string; code?: string }) => row.status === 'missing' && row.code === 'object_not_found'
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const cacheKey = (...parts: unknown[]) => hex(sha256(new TextEncoder().encode(JSON.stringify(parts))))
const sameLegacyObject = (revision: FileRevision, row: { bucket_id?: string; object_name?: string; message_id?: string }) =>
  !revision.legacy_object || row.bucket_id === revision.legacy_object.bucket_id && row.object_name === revision.legacy_object.object_name && row.message_id === revision.legacy_object.message_id
// An unhashed historical object cannot authenticate persistent cached chunks between opens.
const uncached: FileChunkCache = { get: async () => null, put: async () => {}, clear: async () => {} }

/** Retain verified chunks; reconnect only the incomplete chunk, with the signer's authorized origin fallback. */
function remoteSource(size: number, key: string, cache: FileChunkCache, sign: (renew?: boolean, origin?: boolean) => Promise<SignedDownload>, fetcher: () => Promise<typeof fetch>, session: FileDownloadSession, signal?: AbortSignal, progress?: FileContext['progress'], reused?: () => void) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, buffered: Uint8Array = new Uint8Array(), next = -1, interrupted = false
  let last: { index: number; bytes: Uint8Array } | undefined, lease: Download | undefined, origin = false, renewed = false
  const target = () => ({ stage: origin || lease?.bucket_id === 'temporary' ? 'oss' as const : 'cdn' as const, url: lease!.url })
  const transport = createFileDownloadTransport(target, fetcher, session, signal)
  const reset = async () => { transport.cancel(reader); reader = undefined; buffered = new Uint8Array() }
  const chunk = async (index: number): Promise<Uint8Array> => {
    signal?.throwIfAborted()
    const offset = index * FILE_CHUNK_BYTES, length = Math.min(FILE_CHUNK_BYTES, size - offset)
    if (last?.index === index) return last.bytes
    const hit = await cache.get(key, index)
    if (hit && hit.length !== length) throw new Error('Invalid cached file chunk')
    if (hit && (!reader || index < next)) { reused?.(); return hit }
    try {
      if (!lease) { const signed = await sign(); lease = signed.lease; origin = signed.direct }
    } catch (error) { interrupted = isTransientFileReadError(error); throw error }
    return retryFileDownload(target, async () => {
      try {
        if (!reader) {
          let response = await transport.open({ headers: offset ? { Range: `bytes=${offset}-` } : {} })
          const expires = Date.parse(lease!.expires_at ?? '')
          // A valid capability's 403 is a refusal. Only an actually expired lease may be renewed, once per read.
          if (response.status === 403 && !renewed && Number.isFinite(expires) && expires <= Date.now()) {
            void response.body?.cancel().catch(() => undefined); renewed = true
            const signed = await sign(true, origin); lease = signed.lease; origin = signed.direct
            response = await transport.open({ headers: offset ? { Range: `bytes=${offset}-` } : {} })
          }
          if (response.status !== (offset ? 206 : 200) || !response.body || offset && response.headers.get('content-range') !== `bytes ${offset}-${size - 1}/${size}`) {
            void response.body?.cancel().catch(() => undefined)
            return transport.refuse(Object.assign(new Error(`Invalid file range response (HTTP ${response.status})`), { status: response.status }))
          }
          reader = response.body.getReader(); next = index
        }
        if (index !== next) throw new Error('File transfer must continue from its cached prefix')
        const bytes = new Uint8Array(length)
        for (let filled = 0; filled < length;) {
          if (!buffered.length) {
            const received = await transport.read(reader)
            if (received.done) throw new Error('Truncated file response')
            buffered = received.value
          }
          const take = Math.min(buffered.length, length - filled)
          bytes.set(buffered.subarray(0, take), filled); buffered = buffered.subarray(take); filled += take
        }
        if (offset + length === size && (buffered.length || !(await transport.read(reader)).done)) throw new Error('File response has extra bytes')
        await cache.put(key, index, bytes); next++; last = { index, bytes }; interrupted = false
        progress?.(offset + length, size)
        return bytes
      } catch (error) { interrupted = isTransientFileReadError(error); throw error }
    }, signal, async () => {
      await reset()
      if (!origin && lease?.origin_available === true) { const signed = await sign(false, true); lease = signed.lease; origin = signed.direct }
    })
  }
  return { size, interrupted: () => interrupted, dispose: reset, async read(offset: number, length: number) {
    requireFileRange(size, offset, length)
    if (!size) await chunk(0)
    const bytes = new Uint8Array(length)
    for (let filled = 0; filled < length;) {
      const at = offset + filled, part = await chunk(Math.floor(at / FILE_CHUNK_BYTES)), within = at % FILE_CHUNK_BYTES
      const take = Math.min(length - filled, part.length - within)
      bytes.set(part.subarray(within, within + take), filled); filled += take
    }
    return bytes
  } }
}

export function cloudFileProviders(deps: {
  endpoint(context: FileContext): Promise<AttachmentsEndpoint>
  sink(size: number, context: FileContext): Promise<FileSink>
  cache: FileChunkCache; fetch?: typeof fetch
  downloadSession?: FileDownloadSession
  metadata?(context: FileContext): Promise<unknown>
  image?(file: FileBytes, revision: FileRevision): Promise<Blob>
  imageCache?: Pick<Cache, 'match' | 'put'>
}): Pick<FileProviders, 'backend' | 'metadata' | 'managed' | 'temporary' | 'preview' | 'download'> {
  const session = deps.downloadSession ?? fileDownloadSession
  const waits = createSenderWaits()
  const backend = async (context: FileContext) => (await deps.endpoint(context)).supabaseUrl
  const checkEndpoint = (context: FileContext, endpoint: AttachmentsEndpoint) => {
    if (context.backend !== undefined && context.backend !== endpoint.supabaseUrl) throw new FileReadRevokedError('access')
    return endpoint
  }
  const request = async (context: FileContext, route: string, body: Record<string, unknown>) => {
    context.signal?.throwIfAborted()
    const endpoint = checkEndpoint(context, await deps.endpoint(context))
    context.signal?.throwIfAborted()
    return attachmentRequest(endpoint, route, body, context.signal)
  }
  const download = async (context: FileContext, body: Record<string, unknown>, prefer: false | 'file' | 'thumbnail') => {
    context.signal?.throwIfAborted()
    const endpoint = checkEndpoint(context, await deps.endpoint(context))
    context.signal?.throwIfAborted()
    const direct = body.origin === true || prefer !== false && session.prefersOrigin(endpoint.supabaseUrl, prefer)
    const lease = await attachmentRequest(endpoint, 'file-download', { ...body, ...(direct ? { origin: true } : {}) }, context.signal) as Download
    return { lease, direct, scope: endpoint.supabaseUrl }
  }
  const advertised = (signed: SignedDownload & { scope: string }) => {
    if (!signed.direct && signed.lease.origin_available === true && signed.lease.bucket_id !== 'temporary') {
      session.advertise(signed.scope, signed.lease.url, signed.lease.thumb_url)
    }
  }
  const objectTransport = async (context: FileContext) => {
    context.signal?.throwIfAborted()
    const fetcher = deps.fetch ?? (checkEndpoint(context, await deps.endpoint(context))).fetch ?? fetch
    context.signal?.throwIfAborted()
    return fetcher
  }
  const read = async (revision: FileRevision, context: FileContext, encrypted: boolean, destination?: FileSink): Promise<FileBytes> => {
    const ref = 'item_id' in context.ref ? { ...context.ref, version: revision.version } : context.ref
    // A server that knows `download_request_id` answers `download` (the lease, once the copy is ready) and checks the
    // version in the read acknowledgement, which a read for display does not wait for. Older servers answer neither.
    let lease: Download | undefined, combined = false, direct = false
    const downloadRequest = crypto.randomUUID()
    const backendScope = context.backend ?? await backend(context)
    context = { ...context, backend: backendScope }
    if (encrypted) {
      const requestId = crypto.randomUUID()
      type Relay = { status: string; transfer_status: string; host_label?: string | null; host_online?: boolean; download?: Download | null }
      const ready = await (context.reads?.waits ?? waits).until(
        () => request(context, 'file-request', { ref, as: context.actor.actorId, request_id: requestId, download_request_id: downloadRequest }) as Promise<Relay>,
        state => {
          if (state.status !== 'ready' || state.transfer_status === 'retired') throw new FileReadError(state.status === 'expired' ? 'expired' : 'gone', 'File transfer is no longer available')
          if (state.transfer_status === 'ready') return
          if (state.host_online === false) throw new FileReadError('holder_offline', `${state.host_label?.trim() || 'The computer that keeps this file'} is offline. This file opens when it is back online.`)
          return { status: 'waiting_sender', reason: 'relay', holder: { label: state.host_label ?? undefined, online: state.host_online } }
        }, context.signal, context.reads?.state)
      combined = ready.download !== undefined
      if (ready.download) lease = accept(ready.download)
    }
    function accept(row: Download) {
      if (missingObject(row)) throw new MissingFileObjectError()
      if (row.status === 'expired' || row.status === 'gone') throw new FileReadRevokedError(row.status)
      if (row.status !== 'ready' || typeof row.url !== 'string' || row.size_bytes !== (encrypted ? ciphertextSize(revision.size_bytes) : revision.size_bytes) || row.sha256 !== revision.sha256 || !sameLegacyObject(revision, row) ||
        row.origin_available !== undefined && typeof row.origin_available !== 'boolean' ||
        encrypted && (row.ciphertext_bytes !== row.size_bytes || row.codec !== 'secretstream-v1' || !row.key || !/^[0-9a-f]{64}$/.test(row.ciphertext_sha256 ?? '') ||
          lease && (row.ciphertext_sha256 !== lease.ciphertext_sha256 || row.key !== lease.key))) throw new Error('File download commitment changed')
      return lease = row
    }
    const sign = async (renew = false, origin = false, signing = context): Promise<SignedDownload> => {
      const signed = await download(signing, { ref, as: context.actor.actorId,
        request_id: origin && !renew && lease ? lease.download_id : crypto.randomUUID(), ...(origin ? { origin: true } : {}) },
      encrypted || revision.legacy_object ? false : 'file')
      accept(signed.lease); advertised(signed); direct = signed.direct
      return { lease: signed.lease, direct }
    }
    // Managed reads authorize with file-resolve. Only a cache miss needs a download reservation.
    // An encrypted relay also requires this reader’s own grant and acknowledgement.
    if (encrypted && !lease) await sign()
    const digest = encrypted ? lease!.ciphertext_sha256! : revision.sha256
    const key = context.reads
      ? cacheKey(backendScope, context.actor.accountId, encrypted, digest, revision.size_bytes)
      : cacheKey(backendScope, context.actor, fileRefKey(ref), encrypted, digest, revision.size_bytes)
    const acquire = async (transfer: FileContext) => {
      const source = remoteSource(encrypted ? ciphertextSize(revision.size_bytes) : revision.size_bytes, key, revision.legacy_object ? uncached : deps.cache,
        async (renew, origin) => renew || origin ? sign(renew, origin, transfer) : lease ? { lease, direct } : sign(false, false, transfer),
        () => objectTransport(transfer), session, transfer.signal, transfer.progress, () => transfer.reads?.reuse('chunks'))
      let dataKey: Uint8Array | undefined
      let sink: FileSink | undefined
      try {
        sink = destination ?? await deps.sink(revision.size_bytes, transfer)
        if (!revision.size_bytes && !encrypted) await source.read(0, 0)
        // A caller-provided destination is published only after its own read acknowledgement.
        const writing = destination ? { ...sink, commit: async (): Promise<FileBytes> => ({ size: revision.size_bytes, read: async () => { throw new Error('Download is not committed') }, dispose: async () => {} }) } : sink
        if (!encrypted) return await copyVerifiedFile(revision, source, writing, transfer.signal)
        dataKey = Uint8Array.from(atob(lease!.key!), char => char.charCodeAt(0))
        if (dataKey.length !== 32) throw new Error('Invalid file decryption key')
        return (await transformFile({ direction: 'decrypt', revision, source, sink: writing, key: dataKey, ciphertextSha256: lease!.ciphertext_sha256!, signal: transfer.signal })).file
      } catch (error) {
        await sink?.abort()
        if (!source.interrupted() && !transfer.signal?.aborted) await deps.cache.clear(key)
        throw error
      } finally { dataKey?.fill(0); await source.dispose() }
    }
    const file = context.reads && !destination ? await context.reads.acquire(backendScope, 'oss', revision, context, acquire) : await acquire(context)
    // This reader's refusal or failed ACK cannot invalidate another reader's content-addressed chunks.
    const clearAfterRefusal = (error: unknown) => !context.reads || error instanceof FileReadRevokedError && error.reason === 'revision'
    const afterSave = () => deps.cache.clear(key)
    const snapshot = { size: file.size, read: (offset: number, length: number) => file.read(offset, length), dispose: () => file.dispose(), saved: afterSave }
    const saved = async (sink: FileSink) => { const bytes = await sink.commit(); await deps.cache.clear(key); return bytes }
    try {
      context.reads?.state({ status: 'verifying' })
      const changed = (current: Download & { item_id?: string; version?: number }) => {
        if (missingObject(current)) throw new MissingFileObjectError()
        if (current.status !== 'ready') throw new FileReadRevokedError(current.status === 'gone' || current.status === 'expired' ? current.status : 'access')
        if (current.item_id !== revision.item_id || current.version !== revision.version || current.sha256 !== revision.sha256 || current.size_bytes !== revision.size_bytes || !sameLegacyObject(revision, current)) throw new FileReadRevokedError('revision')
      }
      if (encrypted && combined) {
        const downloadId = lease!.download_id
        // Bounded, so a stalled request cannot keep a shown read up; one retry for a transient failure, never for a refusal.
        const acknowledge = () => withBoundedOperation(ACKNOWLEDGEMENT_MS, () => new Error('File read acknowledgement timed out'), async timeout => {
          const acknowledging = { ...context, signal: anySignal([context.signal, timeout]) }
          for (let attempt = 0; ; attempt++) {
            try {
              const read = await request(acknowledging, 'file-read-complete', { download_id: downloadId, as: context.actor.actorId,
                ref, expect: { sha256: revision.sha256, size_bytes: revision.size_bytes } }) as { acknowledged: boolean; current: Download }
              changed(read.current)
              if (!read.acknowledged) throw new FileReadRevokedError('revision')
              return
            } catch (error) {
              if (error instanceof AttachmentsError && (error.status === 403 || error.status === 404)) throw new FileReadRevokedError('access')
              if (attempt || !isTransientFileReadError(error)) throw error
            }
          }
        })
        // A saved copy cannot be taken back: a download still waits. Bytes for display are returned now and the
        // acknowledgement follows; whoever shows them takes them down if it fails (`acknowledged`).
        if (destination) { await acknowledge(); return await saved(destination) }
        const acknowledged = acknowledge().catch(async error => {
          if ((error instanceof FileReadRevokedError || error instanceof MissingFileObjectError) && clearAfterRefusal(error)) await deps.cache.clear(key)
          throw error
        })
        acknowledged.catch(() => undefined)
        return { ...snapshot, acknowledged }
      }
      context.signal?.throwIfAborted()
      const current = await metadata({ ...context, ref }) as Download
      context.signal?.throwIfAborted()
      changed(current)
      if (encrypted) await request(context, 'file-read-complete', { download_id: lease!.download_id, as: context.actor.actorId })
      context.signal?.throwIfAborted()
      return destination ? await saved(destination) : snapshot
    } catch (error) {
      await file.dispose()
      await destination?.abort()
      if (!context.signal?.aborted && clearAfterRefusal(error)) await deps.cache.clear(key)
      throw error
    }
  }
  const metadata = async (context: FileContext) => {
    if (!deps.metadata) return request(context, 'file-resolve', { ref: context.ref, as: context.actor.actorId })
    if (context.backend === undefined) return deps.metadata(context)
    checkEndpoint(context, await deps.endpoint(context))
    const row = await deps.metadata(context)
    checkEndpoint(context, await deps.endpoint(context))
    return row
  }
  return {
    backend,
    download: (revision, context, sink) => read(revision, context, revision.source === 'local', sink),
    async metadata(context): Promise<FileMetadata> {
      context.signal?.throwIfAborted()
      const result = await metadata(context)
      context.signal?.throwIfAborted()
      return parseFileMetadata(result, context.ref)
    },
    managed: (revision, context) => read(revision, context, false),
    temporary: (revision, context) => read(revision, context, true),
    async preview(revision, context, full) {
      const video = revision.content_type.startsWith('video/')
      if (!video && !revision.content_type.startsWith('image/')) throw new Error('File has no media preview')
      if (revision.source === 'managed-object') {
        const key = revision.sha256 === null ? null : `https://attachments.gugu.invalid/preview/${cacheKey(await backend(context), context.actor, fileRefKey(context.ref), revision.sha256)}`
        const hit = key ? await deps.imageCache?.match(key) : null
        if (!video && hit) return hit.blob()
        const ref = 'item_id' in context.ref ? { ...context.ref, version: revision.version } : context.ref
        let signed = await download(context, { ref, as: context.actor.actorId, request_id: crypto.randomUUID() },
          revision.legacy_object ? false : video ? 'file' : 'thumbnail')
        const acceptPreview = (lease: Download) => {
          if (missingObject(lease)) throw new MissingFileObjectError()
          if (lease.status !== 'ready' || lease.sha256 !== revision.sha256 || lease.size_bytes !== revision.size_bytes || !sameLegacyObject(revision, lease)) throw new Error('File preview commitment changed')
        }
        acceptPreview(signed.lease); advertised(signed)
        const lease = signed.lease
        if (video) {
          const expiresAt = Date.parse(lease.expires_at ?? '')
          if (typeof lease.url !== 'string' || !lease.url || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid video preview lease')
          return { url: lease.url, expiresAt } // Every renewal goes through the same ACL and quota signer.
        }
        if (signed.direct || lease.thumb_url) {
          const blob = await readFileThumbnail(signed, async (renew, route) => {
            const origin = route === 'origin'
            if (!renew && (typeof signed.lease.download_id !== 'string' || !signed.lease.download_id)) throw new Error('Invalid thumbnail reservation')
            const next = await download(context, { ref, as: context.actor.actorId,
              request_id: !renew ? signed.lease.download_id : crypto.randomUUID(), ...(origin ? { origin: true } : {}) }, false)
            acceptPreview(next.lease)
            if (!renew) {
              const expires = Date.parse(next.lease.expires_at ?? ''), previous = Date.parse(signed.lease.expires_at ?? '')
              if (next.lease.download_id !== signed.lease.download_id || !Number.isFinite(expires) || !Number.isFinite(previous)
                || origin && expires > previous || expires <= Date.now() || previous <= Date.now()) throw new Error('File thumbnail reservation changed')
              // CDN expiry may retain subsecond precision omitted by an OSS V4 signature.
              next.lease.expires_at = new Date(Math.min(expires, previous)).toISOString()
            }
            advertised(next); signed = next
            return next
          }, () => objectTransport(context), session, context.signal)
          if (key) await deps.imageCache?.put(key, new Response(blob)); return blob
        }
        // The signer owns thumbnail eligibility; formats without one are safe image sources as original blobs.
        return snapshotBlob(await full(), revision.content_type)
      }
      if (video) return snapshotBlob(await full(), revision.content_type)
      if (!deps.image) throw new Error('Local image preview is unavailable')
      return deps.image(await full(), revision) // The original is fully verified/decrypted before generating pixels.
    },
  }
}
