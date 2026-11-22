import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudFileProviders, type FileChunkCache } from '../../../../packages/core/src/cloud/fileProviders'
import type { FileSink } from '../../../../packages/core/src/shared/fileCipher'
import type { FileBytes, FileRevision } from '../../../../packages/core/src/shared/fileResolver'

const MB = 1024 * 1024, CHUNK = 524288
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const context = { ref: { item_id: 'file' }, actor: { accountId: 'owner', actorId: 'agent' } }
const revisionOf = (bytes: Uint8Array): FileRevision => ({ source: 'managed-object', item_id: 'file', version: 2, chat_id: 'group', file_name: 'file.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: digest(bytes) })
// 41 chunks of 512 KiB: three lanes split them 13 / 14 / 14.
const big = randomBytes(20 * MB + 5)
const lane1 = `bytes=${13 * CHUNK}-${27 * CHUNK - 1}`, lane2 = `bytes=${27 * CHUNK}-`

function memory() {
  const chunks = new Map<string, Uint8Array>()
  const store: FileChunkCache = { get: async (key, index) => chunks.get(`${key}:${index}`) ?? null, put: async (key, index, bytes) => { chunks.set(`${key}:${index}`, bytes.slice()) }, clear: vi.fn(async key => { for (const entry of chunks.keys()) if (entry.startsWith(`${key}:`)) chunks.delete(entry) }) }
  return { chunks, store }
}
function collect(): FileSink & { bytes(): Buffer } {
  const parts: Uint8Array[] = []
  const bytesFile = (bytes: Uint8Array): FileBytes => ({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length), dispose: async () => {} })
  return { write: async bytes => { parts.push(bytes.slice()) }, commit: async () => bytesFile(Buffer.concat(parts)), abort: async () => { parts.length = 0 }, bytes: () => Buffer.concat(parts) }
}
/** The byte range a request asks for, served as the object store does. */
function serveRange(request: IncomingMessage, response: ServerResponse, bytes: Uint8Array) {
  const range = request.headers.range
  if (!range) { response.writeHead(200, { 'content-length': bytes.length }); response.end(bytes); return }
  const [, from, to] = /^bytes=(\d+)-(\d*)$/.exec(range)!
  const start = Number(from), end = to ? Number(to) : bytes.length - 1
  response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 })
  response.end(bytes.subarray(start, end + 1))
}
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
async function objectStore(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('HTTP fixture missing')
  return `http://127.0.0.1:${address.port}/file`
}
function providers(url: string, bytes: Uint8Array, cache: FileChunkCache) {
  const signs: unknown[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = String(input).split('/').at(-1)!
    if (route === 'file-resolve') return Response.json({ ...revisionOf(bytes), status: 'ready' })
    if (route === 'file-download') { signs.push(JSON.parse(init!.body as string)); return Response.json({ status: 'ready', url, sha256: digest(bytes), size_bytes: bytes.length, download_id: 'download' }) }
    throw Error(`Unexpected test route ${route}`)
  })
  const endpoint = async () => ({ supabaseUrl: 'https://api.invalid', anonKey: 'test-anon', token: 'test-token', fetch: fetcher as typeof fetch })
  return { signs, cloud: cloudFileProviders({ endpoint, cache, sink: async () => collect(), fetch }) }
}

describe('a large cloud download reads its ranges in parallel', () => {
  it('opens three ranged GETs of one signed URL at once and verifies the assembled file', async () => {
    const ranges: (string | undefined)[] = [], held: (() => void)[] = []
    // Nothing is answered until all three lanes have asked: a sequential reader would never finish.
    const url = await objectStore((request, response) => {
      ranges.push(request.headers.range)
      held.push(() => serveRange(request, response, big))
      if (held.length === 3) for (const answer of held) answer()
    })
    const c = memory(), { cloud, signs } = providers(url, big, c.store), sink = collect()
    await cloud.download!(revisionOf(big), context, sink)
    expect(digest(sink.bytes())).toBe(digest(big))
    expect(ranges.slice(0, 3).sort()).toEqual([`bytes=0-${13 * CHUNK - 1}`, lane1, lane2].sort())
    expect(signs).toHaveLength(1)
    expect(c.chunks.size).toBe(0)
  })

  it('a file of one lane or less stays one plain GET', async () => {
    const small = randomBytes(8 * MB), ranges: (string | undefined)[] = []
    const url = await objectStore((request, response) => { ranges.push(request.headers.range); serveRange(request, response, small) })
    const sink = collect()
    await providers(url, small, memory().store).cloud.download!(revisionOf(small), context, sink)
    expect(digest(sink.bytes())).toBe(digest(small)); expect(ranges).toEqual([undefined])
  })

  it('a store that ignores Range fails the read loudly instead of reading the file once per lane', async () => {
    const url = await objectStore((request, response) => { response.writeHead(200, { 'content-length': big.length }); response.end(big) })
    const sink = collect()
    await expect(providers(url, big, memory().store).cloud.download!(revisionOf(big), context, sink)).rejects.toThrow('Invalid file range response (HTTP 200)')
  })

  it('a lane refused ahead of the reader fails the read at once, not when the reader reaches it', async () => {
    const url = await objectStore((request, response) => {
      if (request.headers.range === lane2) { response.writeHead(403); response.end(); return }
      if (request.headers.range === lane1) { serveRange(request, response, big); return }
      // The first lane never answers: only the refusal can end this read.
      response.writeHead(206, { 'content-range': `bytes 0-${13 * CHUNK - 1}/${big.length}`, 'content-length': 13 * CHUNK })
    })
    const sink = collect()
    await expect(providers(url, big, memory().store).cloud.download!(revisionOf(big), context, sink)).rejects.toMatchObject({ status: 403 })
  })

  it('an interrupted lane reconnects from its first missing chunk and keeps the others streaming', async () => {
    const ranges: (string | undefined)[] = []
    let cut = false
    const url = await objectStore((request, response) => {
      ranges.push(request.headers.range)
      if (request.headers.range === lane1 && !cut) {
        cut = true
        response.writeHead(206, { 'content-range': `bytes ${13 * CHUNK}-${27 * CHUNK - 1}/${big.length}`, 'content-length': 14 * CHUNK })
        response.write(big.subarray(13 * CHUNK, 15 * CHUNK), () => setTimeout(() => response.destroy(), 50))
        return
      }
      serveRange(request, response, big)
    })
    const sink = collect()
    await providers(url, big, memory().store).cloud.download!(revisionOf(big), context, sink)
    expect(digest(sink.bytes())).toBe(digest(big))
    // The cut lane reopens at its first missing chunk (another lane may have taken part of its share by then).
    expect(ranges.filter(range => range?.startsWith(`bytes=${15 * CHUNK}-`))).toHaveLength(1)
  })

  it('a slow connection does not hold the read back: the other lanes take its share', async () => {
    // 120 chunks: three shares of 40. The middle share's first response is throttled (64 KiB per 50 ms, a real slow
    // connection); every other response is served at once.
    const file = randomBytes(60 * MB), slowStart = 40 * CHUNK, requested: { start: number; end: number; slow: boolean }[] = []
    const url = await objectStore((request, response) => {
      const [, from, to] = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '') ?? []
      const start = Number(from ?? 0), end = to ? Number(to) + 1 : file.length
      const slow = start === slowStart && !requested.some(seen => seen.slow)
      requested.push({ start, end, slow })
      if (!slow) return serveRange(request, response, file)
      response.writeHead(206, { 'content-range': `bytes ${start}-${end - 1}/${file.length}`, 'content-length': end - start })
      let at = start
      const drip = setInterval(() => {
        if (response.destroyed || at >= end) { clearInterval(drip); response.end(); return }
        response.write(file.subarray(at, at += 64 * 1024))
      }, 50)
      response.on('close', () => clearInterval(drip))
    })
    const sink = collect()
    await providers(url, file, memory().store).cloud.download!(revisionOf(file), context, sink)
    expect(digest(sink.bytes())).toBe(digest(file))
    // Of the slow share's 40 chunks, the other connections asked for nearly all.
    const taken = new Set<number>()
    for (const { start, end, slow } of requested) if (!slow) for (let c = Math.ceil(start / CHUNK); c * CHUNK < end; c++) if (c >= 40 && c < 80) taken.add(c)
    expect(taken.size).toBeGreaterThanOrEqual(36)
  })
})
