import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { cloudFileProviders, type FileChunkCache } from '../../packages/core/src/cloud/fileProviders'
import type { AttachmentsEndpoint } from '../../packages/core/src/cloud/attachmentsApi'
import type { FileSink } from '../../packages/core/src/shared/fileCipher'
import { createFileResolver, type FileBytes, type FileHandle, type FileRevision } from '../../packages/core/src/shared/fileResolver'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * Contract §7 cell 4: an uploader's forged claim — the real sha256 of `claimed`, the bytes of `served`, the same size —
 * read through the real cloud provider. Only the network (attachments routes and the object store) is faked.
 */
export function forgedFileServer(claimed: Uint8Array, served: Uint8Array, fields: Partial<FileRevision> = {}) {
  if (claimed.length !== served.length) throw Error('a forged claim keeps the size')
  const revision = { source: 'managed-object' as const, item_id: 'item', version: 1, chat_id: 'chat', file_name: 'file.bin',
    content_type: 'application/octet-stream', size_bytes: claimed.length, sha256: sha(claimed), ...fields }
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('https://objects.invalid/')) return new Response(served.slice())
    const route = url.split('/').at(-1)
    if (route === 'file-resolve') return Response.json({ ...revision, status: 'ready' })
    if (route === 'file-download') return Response.json({ status: 'ready', url: 'https://objects.invalid/object', sha256: revision.sha256, size_bytes: served.length, download_id: 'download' })
    throw Error(`unexpected route ${route}`)
  }) as unknown as typeof globalThis.fetch
  const endpoint: AttachmentsEndpoint = { supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch }
  const chunks = new Map<string, Uint8Array>()
  const cache: FileChunkCache = { get: async (key, index) => chunks.get(`${key}:${index}`) ?? null,
    put: async (key, index, bytes) => { chunks.set(`${key}:${index}`, bytes.slice()) },
    clear: async key => { for (const entry of [...chunks.keys()]) if (entry.startsWith(`${key}:`)) chunks.delete(entry) } }
  const delivered: Uint8Array[] = []
  const sink = async (): Promise<FileSink> => {
    let parts: Uint8Array[] = []
    return { write: async bytes => { parts.push(bytes.slice()) }, abort: async () => { parts = [] },
      commit: async (): Promise<FileBytes> => { const all = Buffer.concat(parts); delivered.push(all); return { size: all.length, read: async (o, l) => new Uint8Array(all.subarray(o, o + l)), dispose: async () => {} } } }
  }
  const providers = { ...cloudFileProviders({ endpoint: async () => endpoint, cache, sink }), local: async () => null, ssh: async () => null }
  return {
    revision, endpoint, providers, chunks, delivered,
    async handle(): Promise<FileHandle> {
      const file = await createFileResolver(providers)({ item_id: revision.item_id }, { accountId: 'owner', actorId: 'reader' })
      if (file.status !== 'ready') throw Error('ready expected')
      return file
    },
  }
}
