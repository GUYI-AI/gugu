import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { retryFileDownload } from '../../../../packages/core/src/cloud/fileDownloadRetry'
import { cloudFileProviders } from '../../../../packages/core/src/cloud/fileProviders'
import type { FileSink } from '../../../../packages/core/src/shared/fileCipher'
import type { FileRevision } from '../../../../packages/core/src/shared/fileResolver'

afterEach(() => vi.useRealTimers())
const hop = () => ({ stage: 'metadata' as const, url: 'https://files.invalid/metadata' })
const stopped = () => new DOMException('Read cancelled', 'AbortError')

it('rejects cancellation when an awaited read completes successfully after abort', async () => {
  const abort = new AbortController(), reason = stopped()
  await expect(retryFileDownload(hop, async () => { abort.abort(reason); return 'late result' }, abort.signal)).rejects.toBe(reason)
})

it('does not prepare another retry after cancellation races with a completed wait', async () => {
  vi.useFakeTimers()
  const abort = new AbortController(), reason = stopped(), prepare = vi.fn(async () => {})
  const action = vi.fn(async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }) })
  const result = retryFileDownload(hop, action, abort.signal, prepare).then(value => ({ value }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(0)
  vi.advanceTimersByTime(500)
  abort.abort(reason)
  expect(await result).toEqual({ error: reason })
  expect(prepare).not.toHaveBeenCalled()
  expect(action).toHaveBeenCalledTimes(1)
})

const bytes = new Uint8Array([1, 2])
const revision: FileRevision = { source: 'managed-object', item_id: 'file', version: 1, chat_id: 'chat', file_name: 'file.bin',
  content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
const actor = { accountId: 'owner', actorId: 'reader' }
function fixture() {
  const abort = new AbortController(), reason = stopped()
  const commit = vi.fn(async () => ({ size: bytes.length, read: async () => bytes, dispose: async () => {} }))
  const sink: FileSink = { write: vi.fn(async () => {}), abort: vi.fn(async () => {}), commit }
  const transport = vi.fn<typeof fetch>(async url => String(url).startsWith('https://objects.invalid/')
    ? new Response(bytes)
    : Response.json({ status: 'ready', url: 'https://objects.invalid/file', download_id: 'reservation', size_bytes: bytes.length, sha256: revision.sha256 }))
  const endpoint = { supabaseUrl: 'https://files.invalid', anonKey: 'fixture', token: 'fixture', fetch: transport }
  const cache = { get: async () => null, put: async () => {}, clear: async () => {} }
  return { abort, reason, sink, commit, transport, endpoint, cache, context: { actor, ref: { item_id: 'file' }, signal: abort.signal } }
}

it('does not publish a download after cancellation during final metadata authorization', async () => {
  const f = fixture()
  const cloud = cloudFileProviders({ endpoint: async () => f.endpoint, fetch: f.transport, cache: f.cache, sink: async () => f.sink,
    metadata: async () => { f.abort.abort(f.reason); return { ...revision, status: 'ready' } } })
  await expect(cloud.download!(revision, f.context, f.sink)).rejects.toBe(f.reason)
  expect(f.sink.write).toHaveBeenCalled()
  expect(f.commit).not.toHaveBeenCalled()
  expect(f.sink.abort).toHaveBeenCalled()
})

it('does not dispatch object fetch after endpoint lookup completes past cancellation', async () => {
  const f = fixture(); let endpoints = 0
  const cloud = cloudFileProviders({ endpoint: async () => { if (++endpoints === 2) f.abort.abort(f.reason); return f.endpoint },
    cache: f.cache, sink: async () => f.sink })
  await expect(cloud.download!(revision, f.context, f.sink)).rejects.toBe(f.reason)
  expect(f.transport.mock.calls.map(([url]) => String(url))).toEqual(['https://files.invalid/functions/v1/attachments/file-download'])
  expect(f.commit).not.toHaveBeenCalled()
})

it('does not load custom metadata for a cancelled context', async () => {
  const f = fixture(), metadata = vi.fn(async () => ({ ...revision, status: 'ready' }))
  const cloud = cloudFileProviders({ endpoint: async () => f.endpoint, cache: f.cache, sink: async () => f.sink, metadata })
  f.abort.abort(f.reason)
  await expect(cloud.metadata(f.context)).rejects.toBe(f.reason)
  expect(metadata).not.toHaveBeenCalled()
})
