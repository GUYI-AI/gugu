import { cloudFileProviders } from '@gugu/core/cloud/fileProviders'
import { createFileMetadataLoader } from '@gugu/core/cloud/fileMetadata'
import { attachmentRequest } from '@gugu/core/cloud/attachmentsApi'
import { createCachedFileSink, type FileChunkCache } from '@gugu/core/shared/fileCache'
import { createFileResolver, requireFileRange, FILE_CHUNK_BYTES, type FileBytes, type FileContext, type FileRevision } from '@gugu/core/shared/fileResolver'
import { attachmentsEndpoint } from './attachmentsEndpoint'
import { budgetedCacheWriter } from './attachmentCacheBudget'
import { rendererLogger } from './log'
import { getRendererSession, observeRendererSession } from './sessionPublication'

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
const native = (op: string, context: FileContext, args = {}): Promise<unknown> => window.electronAPI
  ? window.electronAPI.invoke('files:read', { op, actor: context.actor, ref: context.ref, ...args }) : Promise.resolve(null)
/** A read whose bytes the main process carries (this computer's copy, or one over the SSH link): how far it has come, while it runs. */
async function nativeWithProgress(op: 'open' | 'ssh', context: FileContext, args: Record<string, unknown>): Promise<unknown> {
  const electron = window.electronAPI
  if (!context.progress || !electron) return native(op, context, args)
  const id = crypto.randomUUID(), progress = context.progress
  const off = electron.eventOn('files:read-progress', (row) => {
    const { id: of, done, total } = row as { id: string; done: number; total: number }
    if (of === id) progress(done, total)
  })
  try { return await native(op, context, { ...args, progress: id }) } finally { off() }
}
const nativeBytes = (context: FileContext, file: { id: string; size: number }): FileBytes => ({
  size: file.size,
  async read(offset, length) { context.signal?.throwIfAborted(); return new Uint8Array(await native('read', context, { id: file.id, offset, length }) as Uint8Array) },
  async dispose() { await native('dispose', context, { id: file.id }) },
})
/** This machine's bytes, at the address main serves them (`gugu-preview://<id>/<sha>`): read in ranges, never over IPC. */
type ServedFile = { id: string; size: number; url: string }
async function fetchServed(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`This machine's copy could not be read (${response.status})`)
  return response
}
const servedBytes = (context: FileContext, file: ServedFile): FileBytes => ({
  size: file.size,
  async read(offset, length) {
    context.signal?.throwIfAborted()
    requireFileRange(file.size, offset, length)
    if (length === 0) return new Uint8Array()
    const bytes = new Uint8Array(await (await fetchServed(file.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal: context.signal })).arrayBuffer())
    if (bytes.byteLength !== length) throw new Error('This machine\'s copy changed while it was read')
    return bytes
  },
  async dispose() { await native('dispose', context, { id: file.id }) },
})
const cloud = cloudFileProviders({ endpoint, metadata, cache: chunks, sink: async size => createCachedFileSink(chunks, size),
  imageCache: { match: async request => (await attachmentCache()).match(request), put: async (request, response) => putAttachment(request, await response.blob()) },
})
export const resolveFile = createFileResolver({ ...cloud,
  async local(context) {
    const revision = await native('local', context) as FileRevision | null
    return revision ? { revision, async open() { return { ...servedBytes(context, await nativeWithProgress('open', context, { revision }) as ServedFile), here: true } } } : null
  },
  async ssh(revision, context) {
    const file = await nativeWithProgress('ssh', context, { revision }) as { id: string; size: number } | null
    return file ? nativeBytes(context, file) : null
  },
})

/**
 * The bytes of `sha256` the main process holds on this machine (its file store, an original this machine sent, a file it
 * holds), checked against the sha: their address, until `release`. No network.
 */
export async function nativeLocalBytes(sha256: string, contentType = ''): Promise<{ url: string; size: number; blob(): Promise<Blob>; release(): Promise<void> } | null> {
  if (!globalThis.window?.electronAPI) return null
  const context: FileContext = { ref: { attachment_id: sha256 }, actor: fileReader(), signal: fileReadSignal() }
  const file = await native('stored', context, { sha256, contentType }) as ServedFile | null
  if (!file) return null
  return {
    url: file.url, size: file.size,
    async blob() { const blob = await (await fetchServed(file.url, { signal: context.signal })).blob(); return contentType ? blob.slice(0, blob.size, contentType) : blob },
    async release() { await native('dispose', context, { id: file.id }) },
  }
}

/** Where a chat file's bytes are kept, from the same metadata batch the resolver reads: no bytes, no transfer. */
export const fileMetadata = (itemId: string, version?: number) => cloud.metadata({ ref: version === undefined ? { item_id: itemId } : { item_id: itemId, version }, actor: fileReader(), signal: fileReadSignal() })

/** The UI's placement and recent-open tracking share the resolver's no-network local probe. */
export async function localFileRevision(itemId: string): Promise<FileRevision | null> {
  if (!globalThis.window?.electronAPI) return null
  const file = await resolveFile({ item_id: itemId }, fileReader(), { localOnly: true, signal: fileReadSignal() })
  if (file?.status !== 'ready') return null
  try { return file.revision } finally { await file.dispose() }
}
