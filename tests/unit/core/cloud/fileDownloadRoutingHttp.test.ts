import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { cloudFileProviders } from '../../../../packages/core/src/cloud/fileProviders'
import { createFileDownloadSession } from '../../../../packages/core/src/cloud/fileDownloadRouting'
import { setCoreLoggerFactory } from '../../../../packages/core/src/log'
import type { FileRevision } from '../../../../packages/core/src/shared/fileResolver'

it('uses real HTTP bytes for timeout, direct-first file/thumbnail reads and a recovered CDN', async () => {
  const original = new Uint8Array(600_000).fill(71), thumbnail = new TextEncoder().encode('transformed thumbnail')
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const revision: FileRevision = { source: 'managed-object', item_id: 'fixture', version: 1, chat_id: 'chat',
    file_name: 'fixture.png', content_type: 'image/png', size_bytes: original.length, sha256: sha(original) }
  const context = { ref: { item_id: 'fixture' }, actor: { accountId: 'account', actorId: 'reader' } }
  const counts = { cdn: 0, originFile: 0, originThumbnail: 0, abandonedCdn: 0 }
  const signing: Record<string, unknown>[] = [], expires = new Map<string, string>()
  let healthy = false
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const restoreLog = setCoreLoggerFactory(() => quiet)
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://fixture.invalid').pathname
    if (path.startsWith('/functions/')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      res.setHeader('content-type', 'application/json')
      if (path.endsWith('/file-resolve')) { res.end(JSON.stringify({ ...revision, status: 'ready' })); return }
      signing.push(body)
      const id = body.request_id as string
      if (!expires.has(id)) expires.set(id, new Date(Date.now() + 60_000).toISOString())
      const host = body.origin ? 'origin.fixture.invalid' : 'cdn.fixture.invalid'
      res.end(JSON.stringify({ ...revision, status: 'ready', url: `https://${host}/file?signature=fixture`,
        thumb_url: `https://${host}/thumb?signature=fixture`, origin_available: !body.origin,
        download_id: id, expires_at: expires.get(id) }))
      return
    }
    const cdn = path.startsWith('/cdn/')
    if (cdn) counts.cdn++
    if (cdn && !healthy) { res.on('close', () => counts.abandonedCdn++); return }
    const thumb = path.endsWith('/thumb')
    if (!cdn) { if (thumb) counts.originThumbnail++; else counts.originFile++ }
    res.setHeader('content-type', thumb ? 'image/png' : 'application/octet-stream')
    res.end(thumb ? thumbnail : original)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const transport: typeof fetch = (input, init) => {
    const url = new URL(String(input)), hop = url.host === 'cdn.fixture.invalid' ? 'cdn' : 'origin'
    return fetch(`${root}/${hop}${url.pathname}${url.search}`, init)
  }
  const cloud = cloudFileProviders({
    endpoint: async () => ({ supabaseUrl: root, anonKey: 'fixture', token: 'fixture' }), fetch: transport,
    downloadSession: createFileDownloadSession(),
    cache: { get: async () => null, put: async () => {}, clear: async () => {} },
    sink: async () => {
      const chunks: Uint8Array[] = []
      return { write: async bytes => { chunks.push(bytes.slice()) }, abort: async () => {}, commit: async () => {
        const bytes = Buffer.concat(chunks)
        return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length), dispose: async () => {} }
      } }
    },
  })
  const full = vi.fn(async () => { throw new Error('Thumbnail must not read original') })
  let clock: ReturnType<typeof vi.spyOn> | undefined
  const read = async () => {
    const file = await cloud.managed(revision, context)
    expect(sha(Buffer.concat([await file.read(0, 524288), await file.read(524288, original.length - 524288)]))).toBe(revision.sha256)
    await file.dispose()
  }
  try {
    await read()
    expect(counts).toMatchObject({ cdn: 1, originFile: 1, abandonedCdn: 1 })
    expect(signing).toHaveLength(2)
    expect(signing[1]).toMatchObject({ origin: true, request_id: signing[0]!.request_id })
    signing.length = 0
    await read()
    expect(signing).toEqual([expect.objectContaining({ origin: true })])
    expect(counts).toMatchObject({ cdn: 1, originFile: 2 })
    signing.length = 0
    const preview = await cloud.preview!(revision, context, full) as Blob
    expect(sha(new Uint8Array(await preview.arrayBuffer()))).toBe(sha(thumbnail))
    expect(signing).toEqual([expect.objectContaining({ origin: true })])
    expect(counts).toMatchObject({ cdn: 1, originFile: 2, originThumbnail: 1 }); expect(full).not.toHaveBeenCalled()
    healthy = true
    const recoveredAt = Date.now() + 600_000
    clock = vi.spyOn(Date, 'now').mockReturnValue(recoveredAt)
    signing.length = 0
    await read()
    expect(signing).toHaveLength(1); expect(signing[0]).not.toHaveProperty('origin')
    expect(counts.cdn).toBe(2)
    const recoveredPreview = await cloud.preview!(revision, context, full) as Blob
    expect(sha(new Uint8Array(await recoveredPreview.arrayBuffer()))).toBe(sha(thumbnail))
    expect(counts.cdn).toBe(3); expect(full).not.toHaveBeenCalled()
  } finally {
    clock?.mockRestore(); restoreLog(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 20_000)
