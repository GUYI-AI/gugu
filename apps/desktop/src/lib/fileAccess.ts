import { cloudFileProviders } from '@gugu/core/cloud/fileProviders'
import { createFileMetadataLoader } from '@gugu/core/cloud/fileMetadata'
import { attachmentRequest } from '@gugu/core/cloud/attachmentsApi'
import { createCachedFileSink, type FileChunkCache } from '@gugu/core/shared/fileCache'
import { createFileResolver, snapshotBlob, requireFileRange, FILE_CHUNK_BYTES, type FileBytes, type FileContext, type FileRevision } from '@gugu/core/shared/fileResolver'
import { attachmentsEndpoint } from './attachmentsEndpoint'
import { budgetedCacheWriter } from './attachmentCacheBudget'
import { rendererLogger } from './log'
import { getRendererSession, observeRendererSession } from './sessionPublication'

export const attachmentCache = () => caches.open('gugu-attachments-v1')
export const attachmentCacheOrigin = 'https://attachments.gugu.invalid'
const log = rendererLogger('attachments')
export const ATTACHMENT_CACHE_BYTES = 512 * 1024 * 1024
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
const cloud = cloudFileProviders({ endpoint, metadata, cache: chunks, sink: async size => createCachedFileSink(chunks, size),
  imageCache: { match: async request => (await attachmentCache()).match(request), put: async (request, response) => putAttachment(request, await response.blob()) },
  async image(file, revision) {
    const bitmap = await createImageBitmap(await snapshotBlob(file, revision.content_type))
    try {
      const canvas = document.createElement('canvas'), scale = Math.min(1, 560 / bitmap.width)
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d'); if (!context) throw new Error('Image preview is unavailable')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image preview is unavailable')), 'image/webp'))
    } finally { bitmap.close() }
  },
})
export const resolveFile = createFileResolver({ ...cloud,
  async local(context) {
    const revision = await native('local', context) as FileRevision | null
    return revision ? { revision, async open() { return nativeBytes(context, await nativeWithProgress('open', context, { revision }) as { id: string; size: number }) } } : null
  },
  async ssh(revision, context) {
    const file = await nativeWithProgress('ssh', context, { revision }) as { id: string; size: number } | null
    return file ? nativeBytes(context, file) : null
  },
})

/** Where a chat file's bytes are kept, from the same metadata batch the resolver reads: no bytes, no transfer. */
export const fileMetadata = (itemId: string, version?: number) => cloud.metadata({ ref: version === undefined ? { item_id: itemId } : { item_id: itemId, version }, actor: fileReader(), signal: fileReadSignal() })

/** The UI's placement and recent-open tracking share the resolver's no-network local probe. */
export async function localFileRevision(itemId: string): Promise<FileRevision | null> {
  if (!globalThis.window?.electronAPI) return null
  const file = await resolveFile({ item_id: itemId }, fileReader(), { localOnly: true, signal: fileReadSignal() })
  if (file?.status !== 'ready') return null
  try { return file.revision } finally { await file.dispose() }
}
