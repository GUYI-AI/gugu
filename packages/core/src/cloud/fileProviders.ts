import { egress } from '../shared/egress'
import { sha256 } from '@noble/hashes/sha2.js'
import { copyVerifiedFile, ciphertextSize, transformFile, type FileSink } from '../shared/fileCipher'
// Signed-URL expiries are on the backend's clock (`@@@server-clock`).
import { serverNow } from '../shared/serverClock'
import { FILE_CHUNK_BYTES, FileReadRevokedError, MissingFileObjectError, fileRefKey, relayRefusedError, requireFileRange, parseFileMetadata, snapshotBlob, type FileBytes, type FileContext, type FileMetadata, type FilePreview, type FileProviders, type FileRevision } from '../shared/fileResolver'
import type { FileChunkCache } from '../shared/fileCache'
import { AttachmentsError, attachmentRequest, type AttachmentsEndpoint } from './attachmentsApi'
import { withBoundedOperation } from './boundedOperation'
import { anySignal } from '../shared/anySignal'
import { isTransientFileReadError, retryFileDownload } from './fileDownloadRetry'
import { createFileDownloadTransport, fileDownloadSession, type FileDownloadSession } from './fileDownloadRouting'

/** How long bytes shown before their read acknowledgement may stay up while it is pending. */
const ACKNOWLEDGEMENT_MS = 15_000

export type { FileChunkCache } from '../shared/fileCache'
type Download = { status: string; code?: string; url: string; expires_at?: string; origin_available?: boolean; download_id: string; key?: string; codec?: string; sha256: string | null; size_bytes: number; ciphertext_bytes?: number; ciphertext_sha256?: string; bucket_id?: string; object_name?: string; message_id?: string }
type SignedDownload = { lease: Download; direct: boolean }
const missingObject = (row: { status: string; code?: string }) => row.status === 'missing' && row.code === 'object_not_found'
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const cacheKey = (context: FileContext, digest: string) => hex(sha256(new TextEncoder().encode(JSON.stringify([context.actor, fileRefKey(context.ref), digest]))))
const sameLegacyObject = (revision: FileRevision, row: { bucket_id?: string; object_name?: string; message_id?: string }) =>
  !revision.legacy_object || row.bucket_id === revision.legacy_object.bucket_id && row.object_name === revision.legacy_object.object_name && row.message_id === revision.legacy_object.message_id
// An unhashed historical object cannot authenticate persistent cached chunks between opens.
/** Where a preview's verified bytes are kept for this reader and reference (`imageCache`). */
export const filePreviewCacheKey = (context: FileContext, sha256: string) => `https://attachments.gugu.invalid/preview/${cacheKey(context, sha256)}`
const uncached: FileChunkCache = { get: async () => null, put: async () => {}, clear: async () => {} }

/** Bytes per download lane: a file gets one more parallel ranged GET per this many bytes, up to `DOWNLOAD_LANES`. */
const DOWNLOAD_LANE_BYTES = 8 * 1024 * 1024
// Three connections saturate the object store from one host (measured 11-22: 3 streams ≈ 11.7 MB/s, 6 add nothing).
const DOWNLOAD_LANES = 3
/** What a lane reads from its connection ahead of the chunk it is putting into the cache. */
const DOWNLOAD_READ_AHEAD_BYTES = 8 * 1024 * 1024

/**
 * Retain verified chunks; reconnect only the incomplete chunk, with the signer's authorized origin fallback.
 * @@@download-lanes - a large file is read by up to `lanes` lanes of the same signed URL at once, each on its own
 * connection. Each starts on an equal share and puts every chunk into the chunk cache, which is where every chunk already
 * goes; the reader takes them in order, so the whole-file digest is still checked in order. A lane that finishes its
 * share takes the back half of the largest share left, in whole chunks, on a new ranged GET; the lane that gave it up stops
 * where the taken half starts. Halving keeps the GETs few, and the read ends when the file does, not when the slowest
 * connection's third does.
 */
function remoteSource(size: number, key: string, cache: FileChunkCache, sign: (renew?: boolean, origin?: boolean) => Promise<SignedDownload>, fetcher: () => Promise<typeof globalThis.fetch>, session: FileDownloadSession, signal?: AbortSignal, progress?: FileContext['progress'], lanes = 1) {
  const count = Math.max(1, Math.ceil(size / FILE_CHUNK_BYTES))
  const width = Math.max(1, Math.min(lanes, Math.ceil(size / DOWNLOAD_LANE_BYTES)))
  const stop = new AbortController(), stopping = anySignal([signal, stop.signal])
  let lease: Download | undefined, origin = false, leasing: Promise<void> | undefined, renewal: Promise<void> | undefined, switching: Promise<void> | undefined
  let last: { index: number; bytes: Uint8Array } | undefined, received = 0, failure: unknown, failed: ((error: unknown) => void) | undefined
  const settled = new Set<number>()
  const failing = new Promise<never>((_, reject) => { failed = reject }); failing.catch(() => undefined)
  const apply = (signed: SignedDownload) => { lease = signed.lease; origin = signed.direct }
  const target = () => ({ stage: origin || lease?.bucket_id === 'temporary' ? 'oss' as const : 'cdn' as const, url: lease!.url })
  const length = (index: number) => Math.min(FILE_CHUNK_BYTES, size - index * FILE_CHUNK_BYTES)
  const done = (index: number) => {
    if (settled.has(index)) return
    settled.add(index); received += length(index); progress?.(received, size)
  }
  const lane = (first: number, end: number) => {
    const transport = createFileDownloadTransport(target, fetcher, session, stopping)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, buffered: Uint8Array = new Uint8Array(), next = -1, interrupted = false
    // The last byte the open response was asked for: a lane's share can shrink under an open response.
    let stopByte = size
    const reset = async () => { transport.cancel(reader); reader = undefined; buffered = new Uint8Array() }
    const open = (offset: number) => {
      stopByte = Math.min(runner.end * FILE_CHUNK_BYTES, size)
      return transport.open({ headers: stopByte !== size ? { Range: `bytes=${offset}-${stopByte - 1}` } : offset ? { Range: `bytes=${offset}-` } : {} })
    }
    const chunk = async (index: number): Promise<Uint8Array> => {
      stopping.throwIfAborted()
      const offset = index * FILE_CHUNK_BYTES, bytes = new Uint8Array(length(index))
      const hit = await cache.get(key, index)
      if (hit && hit.length !== bytes.length) throw new Error('Invalid cached file chunk')
      if (hit && (!reader || index < next)) { done(index); return hit }
      try {
        if (!lease) await (leasing ??= sign().then(apply).finally(() => { leasing = undefined }))
      } catch (error) { interrupted = isTransientFileReadError(error); throw error }
      return retryFileDownload(target, async () => {
        try {
          if (!reader) {
            const used = lease
            let response = await open(offset)
            const expires = Date.parse(used!.expires_at ?? '')
            // A valid capability's 403 is a refusal. Only an actually expired lease may be renewed, once per read; a lane
            // whose lease another lane already renewed reopens with the new one.
            if (response.status === 403 && lease === used && !renewal && Number.isFinite(expires) && expires <= serverNow()) renewal = sign(true, origin).then(apply)
            if (response.status === 403 && renewal) {
              void response.body?.cancel().catch(() => undefined)
              await renewal
              if (lease !== used) response = await open(offset)
            }
            const ranged = offset || stopByte !== size
            if (response.status !== (ranged ? 206 : 200) || !response.body || ranged && response.headers.get('content-range') !== `bytes ${offset}-${stopByte - 1}/${size}`) {
              void response.body?.cancel().catch(() => undefined)
              return transport.refuse(Object.assign(new Error(`Invalid file range response (HTTP ${response.status})`), { status: response.status }))
            }
            // The network keeps flowing while chunks are put into the cache: without this the socket waits on each put,
            // and over a real round trip a lane ran at a third of what its connection carries.
            reader = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(undefined, new ByteLengthQueuingStrategy({ highWaterMark: DOWNLOAD_READ_AHEAD_BYTES }))).getReader(); next = index
          }
          if (index !== next) throw new Error('File transfer must continue from its cached prefix')
          for (let filled = 0; filled < bytes.length;) {
            if (!buffered.length) {
              const received = await transport.read(reader)
              if (received.done) throw new Error('Truncated file response')
              buffered = received.value
            }
            const take = Math.min(buffered.length, bytes.length - filled)
            bytes.set(buffered.subarray(0, take), filled); buffered = buffered.subarray(take); filled += take
          }
          if (offset + bytes.length === stopByte && (buffered.length || !(await transport.read(reader)).done)) throw new Error('File response has extra bytes')
          await cache.put(key, index, bytes); next++; interrupted = false
          done(index)
          return bytes
        } catch (error) { if (!stop.signal.aborted) interrupted = isTransientFileReadError(error); throw error }
      }, stopping, async () => {
        await reset()
        if (!origin && lease?.origin_available === true) await (switching ??= sign(false, true).then(apply))
      })
    }
    const runner = { pos: first, end, chunk, reset, interrupted: () => interrupted }
    return runner
  }
  const all = Array.from({ length: width }, (_, k) => lane(Math.floor(k * count / width), Math.floor((k + 1) * count / width)))
  // The chunk the reader is waiting for, handed over as it arrives; any other it takes from the cache.
  const arrived = new Map<number, (bytes: Uint8Array) => void>()
  const work = async (runner: (typeof all)[number]) => {
    for (;;) {
      while (runner.pos < runner.end) {
        const index = runner.pos++
        const bytes = await runner.chunk(index)
        arrived.get(index)?.(bytes); arrived.delete(index)
      }
      await runner.reset()
      const from = all.reduce((most, other) => other.end - other.pos > most.end - most.pos ? other : most)
      const taken = Math.floor((from.end - from.pos) / 2)
      if (!taken) return
      runner.pos = from.end - taken; runner.end = from.end; from.end = runner.pos
    }
  }
  let running: Promise<unknown>[] | undefined
  const start = () => {
    running ??= all.map(runner => work(runner).catch(error => { if (failure === undefined && !stop.signal.aborted) { failure = error; failed?.(error) } }))
  }
  const chunk = async (index: number): Promise<Uint8Array> => {
    signal?.throwIfAborted()
    if (last?.index === index) return last.bytes
    // One lane is the reader's own: it reads on demand, as a read always did.
    if (width === 1) {
      const bytes = await all[0]!.chunk(index)
      last = { index, bytes }
      return bytes
    }
    start()
    const bytes = await Promise.race([failing, settled.has(index) ? cache.get(key, index).then(hit => {
      if (!hit || hit.length !== length(index)) throw new Error('Invalid cached file chunk')
      return hit
    }) : new Promise<Uint8Array>(resolve => arrived.set(index, resolve))])
    last = { index, bytes }
    return bytes
  }
  return { size, interrupted: () => all.some(runner => runner.interrupted()), async dispose() {
    // Lanes still reading ahead stop before the caller keeps or clears their chunks.
    stop.abort(); await Promise.all([...all.map(runner => runner.reset()), ...running ?? []])
  }, async read(offset: number, length: number) {
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
  cache: FileChunkCache; fetch?: typeof globalThis.fetch
  downloadSession?: FileDownloadSession
  metadata?(context: FileContext): Promise<unknown>
  imageCache?: Pick<Cache, 'match' | 'put'>
}): Pick<FileProviders, 'metadata' | 'managed' | 'temporary' | 'preview' | 'expiredPreview' | 'download'> {
  const session = deps.downloadSession ?? fileDownloadSession
  const request = async (context: FileContext, route: string, body: Record<string, unknown>) => {
    context.signal?.throwIfAborted()
    const endpoint = await deps.endpoint(context)
    context.signal?.throwIfAborted()
    return attachmentRequest(endpoint, route, body, context.signal)
  }
  const download = async (context: FileContext, body: Record<string, unknown>, prefer: boolean) => {
    context.signal?.throwIfAborted()
    const endpoint = await deps.endpoint(context)
    context.signal?.throwIfAborted()
    const direct = body.origin === true || prefer !== false && session.prefersOrigin(endpoint.supabaseUrl)
    const lease = await attachmentRequest(endpoint, 'file-download', { ...body, ...(direct ? { origin: true } : {}) }, context.signal) as Download
    return { lease, direct, scope: endpoint.supabaseUrl }
  }
  const advertised = (signed: SignedDownload & { scope: string }) => {
    if (!signed.direct && signed.lease.origin_available === true && signed.lease.bucket_id !== 'temporary') {
      session.advertise(signed.scope, signed.lease.url)
    }
  }
  const objectTransport = async (context: FileContext) => {
    context.signal?.throwIfAborted()
    const fetcher = deps.fetch ?? (await deps.endpoint(context)).fetch ?? egress.fetch
    context.signal?.throwIfAborted()
    return fetcher
  }
  const read = async (revision: FileRevision, context: FileContext, encrypted: boolean, destination?: FileSink): Promise<FileBytes> => {
    const ref = 'item_id' in context.ref ? { ...context.ref, version: revision.version } : context.ref
    // A server that knows `download_request_id` answers `download` (the lease, once the copy is ready) and checks the
    // version in the read acknowledgement, which a read for display does not wait for. Older servers answer neither.
    let lease: Download | undefined, combined = false, direct = false
    const downloadRequest = crypto.randomUUID()
    if (encrypted) await withBoundedOperation(600_000, () => new Error('File device is unavailable or its transfer timed out'), async timeout => {
      const waiting = { ...context, signal: anySignal([context.signal, timeout]) }, requestId = crypto.randomUUID()
      for (;;) {
        waiting.signal.throwIfAborted()
        const state = await request(waiting, 'file-request', { ref, as: context.actor.actorId, request_id: requestId, download_request_id: downloadRequest }) as { status: string; transfer_status: string; transfer_declined?: string | null; host_label?: string | null; host_online?: boolean; download?: Download | null }
        // A request ended with a reason (the holder declined it, or the server refused the holder) stops now, with that reason.
        if (state.status === 'ready' && state.transfer_status === 'retired' && state.transfer_declined) throw relayRefusedError(state.transfer_declined)
        if (state.status !== 'ready' || state.transfer_status === 'retired') throw new Error('File transfer is no longer available')
        if (state.transfer_status === 'ready') {
          combined = state.download !== undefined
          if (state.download) lease = accept(state.download)
          break
        }
        // Only the device that keeps this version can send it: say so instead of waiting while it is offline.
        if (state.host_online === false) throw new Error(`${state.host_label?.trim() || 'The computer that keeps this file'} is offline. This file opens when it is back online.`)
        await new Promise(resolve => setTimeout(resolve, 700))
      }
    })
    function accept(row: Download) {
      if (missingObject(row)) throw new MissingFileObjectError()
      if (row.status !== 'ready' || typeof row.url !== 'string' || row.size_bytes !== (encrypted ? ciphertextSize(revision.size_bytes) : revision.size_bytes) || row.sha256 !== revision.sha256 || !sameLegacyObject(revision, row) ||
        row.origin_available !== undefined && typeof row.origin_available !== 'boolean' ||
        encrypted && (row.ciphertext_bytes !== row.size_bytes || row.codec !== 'secretstream-v1' || !row.key || !/^[0-9a-f]{64}$/.test(row.ciphertext_sha256 ?? '') ||
          lease && (row.ciphertext_sha256 !== lease.ciphertext_sha256 || row.key !== lease.key))) throw new Error('File download commitment changed')
      return lease = row
    }
    const sign = async (renew = false, origin = false): Promise<SignedDownload> => {
      const signed = await download(context, { ref, as: context.actor.actorId,
        request_id: origin && !renew && lease ? lease.download_id : crypto.randomUUID(), ...(origin ? { origin: true } : {}) },
      !encrypted && !revision.legacy_object)
      accept(signed.lease); advertised(signed); direct = signed.direct
      return { lease: signed.lease, direct }
    }
    // A key still requires the current download ACL, even if every ciphertext chunk is cached.
    if (encrypted && !lease) await sign()
    const digest = encrypted ? lease!.ciphertext_sha256! : revision.sha256, key = cacheKey(context, digest ?? crypto.randomUUID())
    // An unhashed historical object keeps no chunks, so it has nowhere to put bytes read ahead: one lane.
    const source = remoteSource(encrypted ? ciphertextSize(revision.size_bytes) : revision.size_bytes, key, revision.legacy_object ? uncached : deps.cache, async (renew, origin) => renew || origin ? sign(renew, origin) : lease ? { lease, direct } : sign(), () => objectTransport(context), session, context.signal, context.progress, revision.legacy_object ? 1 : DOWNLOAD_LANES)
    // @@@save-through-cache - a save to disk reads through the same chunk cache as a read for display, so a read that dies
    // halfway (the process stops, the retry window runs out) resumes from the chunks it has; once it ends they are dropped.
    let dataKey: Uint8Array | undefined
    let sink: FileSink | undefined
    try {
      sink = destination ?? await deps.sink(revision.size_bytes, context)
      if (!revision.size_bytes && !encrypted) await source.read(0, 0)
      if (encrypted) {
        dataKey = Uint8Array.from(atob(lease!.key!), char => char.charCodeAt(0))
        if (dataKey.length !== 32) throw new Error('Invalid file decryption key')
      }
      // Downloads publish only after the final authorization read; private snapshot readers retain their existing sink.
      const writing = destination ? { ...sink, commit: async (): Promise<FileBytes> => ({ size: revision.size_bytes, read: async () => { throw new Error('Download is not committed') }, dispose: async () => {} }) } : sink
      const file = encrypted ? (await transformFile({ direction: 'decrypt', revision, source, sink: writing, key: dataKey!, ciphertextSha256: lease!.ciphertext_sha256!, signal: context.signal })).file : await copyVerifiedFile(revision, source, writing, context.signal)
      const changed = (current: Download) => {
        if (missingObject(current)) throw new MissingFileObjectError()
        if (current.status !== 'ready') throw new FileReadRevokedError(current.status === 'gone' || current.status === 'expired' ? current.status : 'access')
        if (current.sha256 !== revision.sha256 || current.size_bytes !== revision.size_bytes || !sameLegacyObject(revision, current)) throw new FileReadRevokedError('revision')
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
        if (destination) { await acknowledge(); return await sink.commit() }
        const acknowledged = acknowledge()
        acknowledged.catch(() => undefined)
        return { size: file.size, read: (offset, length) => file.read(offset, length), dispose: () => file.dispose(), acknowledged }
      }
      context.signal?.throwIfAborted()
      const current = await metadata({ ...context, ref }) as Download
      context.signal?.throwIfAborted()
      changed(current)
      if (encrypted) await request(context, 'file-read-complete', { download_id: lease!.download_id, as: context.actor.actorId })
      context.signal?.throwIfAborted()
      return destination ? await sink.commit() : file
    } catch (error) { await sink?.abort(); throw error } finally {
      dataKey?.fill(0); if (lease) delete lease.key; await source.dispose()
      // The sink holds the bytes once read. Only an interrupted or abandoned read keeps its chunks, to resume from them.
      if (!source.interrupted() && !context.signal?.aborted) await deps.cache.clear(key)
    }
  }
  const readPreview = async (preview: FilePreview, ref: FileContext['ref'], context: FileContext) => {
    const key = filePreviewCacheKey(context, preview.sha256)
    const hit = await deps.imageCache?.match(key)
    if (hit) return hit.blob()
    let lease: Download | undefined
    const sign = async (renew = false, origin = false): Promise<SignedDownload> => {
      const signed = await download(context, { ref, as: context.actor.actorId, preview: true,
        request_id: origin && !renew && lease ? lease.download_id : crypto.randomUUID(), ...(origin ? { origin: true } : {}) }, true)
      if (signed.lease.status !== 'ready' || signed.lease.sha256 !== preview.sha256) throw new Error('File preview changed')
      advertised(signed); lease = signed.lease
      return { lease, direct: signed.direct }
    }
    const source = remoteSource(preview.size_bytes, key, uncached, sign, () => objectTransport(context), session, context.signal)
    try {
      const bytes = await source.read(0, preview.size_bytes)
      if (hex(sha256(bytes)) !== preview.sha256) throw new Error('File preview bytes changed')
      const blob = new Blob([bytes], { type: preview.content_type })
      await deps.imageCache?.put(key, new Response(blob)); return blob
    } finally { await source.dispose() }
  }
  const metadata = deps.metadata ?? ((context: FileContext) => request(context, 'file-resolve', { ref: context.ref, as: context.actor.actorId }))
  return {
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
      if (video && revision.source === 'managed-object') {
        const ref = 'item_id' in context.ref ? { ...context.ref, version: revision.version } : context.ref
        const signed = await download(context, { ref, as: context.actor.actorId, request_id: crypto.randomUUID() }, !revision.legacy_object)
        const lease = signed.lease
        if (missingObject(lease)) throw new MissingFileObjectError()
        if (lease.status !== 'ready' || lease.sha256 !== revision.sha256 || lease.size_bytes !== revision.size_bytes || !sameLegacyObject(revision, lease)) throw new Error('File preview commitment changed')
        advertised(signed)
        const expiresAt = Date.parse(lease.expires_at ?? '')
        if (typeof lease.url !== 'string' || !lease.url || !Number.isFinite(expiresAt) || expiresAt <= serverNow()) throw new Error('Invalid video preview lease')
        return { url: lease.url, expiresAt } // Every renewal goes through the same ACL and quota signer.
      }
      // A video kept on a machine has no preview of its own: it is read whole, like the file it is.
      if (video) throw new Error('Local media preview is unavailable')
      // An image shows the preview its sender uploaded with it; without one, the original, read like any file.
      if (!revision.preview) return snapshotBlob(await full(), revision.content_type)
      return readPreview(revision.preview, 'item_id' in context.ref ? { ...context.ref, version: revision.version } : context.ref, context)
    },
    expiredPreview: (preview, context) => readPreview(preview, context.ref, context),
  }
}
