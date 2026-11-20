import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cloudFileProviders } from '../../../../packages/core/src/cloud/fileProviders'
import { createFileDownloadSession, type FileDownloadSession } from '../../../../packages/core/src/cloud/fileDownloadRouting'
import { attachmentRequest, AttachmentsError } from '../../../../packages/core/src/cloud/attachmentsApi'
import { setCoreLoggerFactory } from '../../../../packages/core/src/log'
import type { FileSink } from '../../../../packages/core/src/shared/fileCipher'
import type { FileRevision } from '../../../../packages/core/src/shared/fileResolver'

const bytes = new Uint8Array(600_000).fill(53)
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const revision: FileRevision = { source: 'managed-object', item_id: 'file', version: 1, chat_id: 'chat', file_name: 'test.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: sha(bytes) }
const context = { ref: { item_id: 'file' }, actor: { actorId: 'reader', accountId: 'owner' } }
const network = (code = 'ECONNRESET') => new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code }) })
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
let restoreLog: () => void
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); restoreLog = setCoreLoggerFactory(() => logger) })
afterEach(() => { restoreLog(); vi.useRealTimers(); vi.clearAllMocks() })
function fixture(options: { origin?: boolean; expired?: boolean; signerFails?: boolean; thumbnail?: boolean; session?: FileDownloadSession } = {}) {
  const session = options.session ?? createFileDownloadSession()
  const cache = new Map<number, Uint8Array>(), committed = vi.fn(), requests: Record<string, unknown>[] = []
  const object = vi.fn<typeof fetch>(async (_url, init) => {
    const offset = Number(new Headers(init?.headers).get('Range')?.match(/bytes=(\d+)-/)?.[1] ?? 0)
    return new Response(bytes.slice(offset), { status: offset ? 206 : 200, headers: offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {} })
  })
  let signed = 0
  const expiry = new Map<string, string>()
  const api = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/file-resolve')) return Response.json({ ...revision, status: 'ready' })
    const body = JSON.parse(String(init?.body)); requests.push(body); signed++
    if (body.origin && options.signerFails) return Response.json({ error: 'signing_failed', message: 'Origin signing failed' }, { status: 503 })
    if (!expiry.has(body.request_id)) expiry.set(body.request_id, new Date(Date.now() + (options.expired && signed === 1 ? -1 : 60_000)).toISOString())
    return Response.json({ status: 'ready', url: body.origin ? `https://oss.invalid/file?x-oss-signature=secret-${signed}` : `https://cdn.invalid/file?auth_key=secret-${signed}`,
      ...(options.origin && !body.origin ? { origin_available: true } : {}),
      ...(options.thumbnail ? { thumb_url: body.origin ? 'https://oss.invalid/thumb.png?x-oss-signature=thumbnail' : 'https://cdn.invalid/thumb.png' } : {}),
      expires_at: expiry.get(body.request_id),
      size_bytes: bytes.length, sha256: revision.sha256, download_id: body.request_id })
  })
  const endpoint = { supabaseUrl: 'https://signer.invalid', anonKey: 'fixture', token: 'fixture', fetch: api }
  const sink = async (): Promise<FileSink> => {
    const chunks: Uint8Array[] = []
    return { write: async part => { chunks.push(part.slice()) }, abort: async () => {}, commit: async () => {
      const joined = Buffer.concat(chunks); committed(); return { size: joined.length, read: async (offset, length) => joined.subarray(offset, offset + length), dispose: async () => {} }
    } }
  }
  const cloud = cloudFileProviders({ endpoint: async () => endpoint, fetch: object, sink, downloadSession: session,
    cache: { get: async (_key, index) => cache.get(index) ?? null, put: async (_key, index, part) => { cache.set(index, part.slice()) }, clear: async () => cache.clear() } })
  return { cloud, api, object, endpoint, requests, cache, committed, session }
}
async function finish<T>(promise: Promise<T>) { const result = promise.then(value => ({ value }), error => ({ error })); await vi.runAllTimersAsync(); return result }
function value<T>(result: { value: T } | { error: unknown }): T { if ('error' in result) throw result.error; return result.value }

it('retries the same authenticated signing reservation twice at 500/2000ms', async () => {
  const f = fixture(); f.api.mockRejectedValueOnce(network()).mockRejectedValueOnce(network('UND_ERR_CONNECT_TIMEOUT'))
  const work = f.cloud.managed(revision, context), settled = vi.fn(); void work.then(settled, () => undefined)
  await vi.advanceTimersByTimeAsync(499); expect(f.api).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); expect(f.api).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1999); expect(f.api).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1); const file = await work
  expect(settled).toHaveBeenCalledTimes(1)
  const signing = f.api.mock.calls.filter(([url]) => String(url).endsWith('/file-download'))
  expect(signing).toHaveLength(3)
  expect(new Set(signing.map(([, init]) => JSON.parse(String(init?.body)).request_id)).size).toBe(1)
  expect(sha(await file.read(0, 524288))).toBe(sha(bytes.subarray(0, 524288)))
})
it('switches to the separately signed OSS URL on a CDN connection failure and preserves hash verification', async () => {
  const f = fixture({ origin: true }); f.object.mockRejectedValueOnce(network('ETIMEDOUT'))
  const file = value(await finish(f.cloud.managed(revision, context)))
  expect(f.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid', 'oss.invalid'])
  expect(f.committed).toHaveBeenCalledTimes(1); expect(file.size).toBe(bytes.length)
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-')
})
it('bounds an unresponsive CDN connection to three seconds, then creates the next origin read with one signing call', async () => {
  const f = fixture({ origin: true }), started = Date.now()
  f.object.mockImplementationOnce(() => new Promise(() => {}))
  const work = f.cloud.managed(revision, context).then(value => ({ value }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(2_999)
  expect(f.object).toHaveBeenCalledTimes(1); expect(f.requests).toHaveLength(1)
  expect(f.object.mock.calls[0]![1]!.signal!.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.object.mock.calls[0]![1]!.signal!.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(500)
  const first = value(await work)
  expect(Date.now() - started).toBe(3_500)
  expect(sha(Buffer.concat([await first.read(0, 524288), await first.read(524288, bytes.length - 524288)]))).toBe(revision.sha256)
  const next = fixture({ origin: true, session: f.session })
  const file = value(await finish(next.cloud.managed(revision, context)))
  expect(next.requests).toEqual([expect.objectContaining({ origin: true })])
  expect(next.requests[0]!.request_id).not.toBe(f.requests[0]!.request_id)
  expect(next.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['oss.invalid'])
  expect(sha(Buffer.concat([await file.read(0, 524288), await file.read(524288, bytes.length - 524288)]))).toBe(revision.sha256)
})
it('rechecks a recovered CDN after ten minutes without extending cooldown on origin reads', async () => {
  const f = fixture({ origin: true }), started = Date.now()
  f.object.mockRejectedValueOnce(network('ETIMEDOUT'))
  value(await finish(f.cloud.managed(revision, context)))
  await vi.advanceTimersByTimeAsync(300_000)
  const during = fixture({ origin: true, session: f.session })
  value(await finish(during.cloud.managed(revision, context)))
  expect(during.requests).toEqual([expect.objectContaining({ origin: true })])
  expect(during.object.mock.calls.every(([url]) => new URL(String(url)).host === 'oss.invalid')).toBe(true)
  await vi.advanceTimersByTimeAsync(started + 600_000 - Date.now())
  const recovered = fixture({ origin: true, session: f.session })
  value(await finish(recovered.cloud.managed(revision, context)))
  expect(recovered.requests).toHaveLength(1); expect(recovered.requests[0]).not.toHaveProperty('origin')
  expect(recovered.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid'])
})
it('allows a healthy CDN stream to progress for longer than the probe deadline', async () => {
  const f = fixture({ origin: true }), started = Date.now()
  let offset = 0
  f.object.mockResolvedValueOnce(new Response(new ReadableStream({ async pull(controller) {
    await new Promise(resolve => setTimeout(resolve, 2_000))
    controller.enqueue(bytes.slice(offset, offset += 100_000))
    if (offset === bytes.length) controller.close()
  } })))
  const file = value(await finish(f.cloud.managed(revision, context)))
  expect(Date.now() - started).toBeGreaterThan(3_000)
  expect(f.requests).toHaveLength(1); expect(f.requests[0]).not.toHaveProperty('origin')
  expect(f.object).toHaveBeenCalledTimes(1)
  expect(sha(Buffer.concat([await file.read(0, 524288), await file.read(524288, bytes.length - 524288)]))).toBe(revision.sha256)
})
it('resumes only the incomplete chunk after a stalled CDN body even when its cancellation never settles', async () => {
  const f = fixture({ origin: true }), cancelled = vi.fn(() => new Promise<void>(() => {}))
  f.object.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 524288 + 20))
  }, cancel: cancelled })))
  const file = value(await finish(f.cloud.managed(revision, context)))
  expect(cancelled).toHaveBeenCalled()
  expect(f.cache.size).toBe(0)
  expect(new Headers(f.object.mock.calls[1]?.[1]?.headers).get('Range')).toBe('bytes=524288-')
  expect(f.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid', 'oss.invalid'])
  expect(sha(Buffer.concat([await file.read(0, 524288), await file.read(524288, bytes.length - 524288)]))).toBe(revision.sha256)
})
it('does not remember a caller cancellation as CDN failure', async () => {
  const f = fixture({ origin: true }), abort = new AbortController()
  f.object.mockImplementationOnce(() => new Promise(() => {}))
  const work = f.cloud.managed(revision, { ...context, signal: abort.signal }).then(value => ({ value }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(0)
  abort.abort(new DOMException('Stopped', 'AbortError'))
  expect(await work).toHaveProperty('error', expect.objectContaining({ name: 'AbortError' }))
  const next = fixture({ origin: true, session: f.session })
  value(await finish(next.cloud.managed(revision, context)))
  expect(next.requests[0]).not.toHaveProperty('origin')
  expect(next.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid'])
})
it('discards a late CDN response after its timed-out request has already completed through origin', async () => {
  const f = fixture({ origin: true }), cancelled = vi.fn()
  let late!: (response: Response) => void
  f.object.mockImplementationOnce(() => new Promise(resolve => { late = resolve }))
  const file = value(await finish(f.cloud.managed(revision, context)))
  late(new Response(new ReadableStream({ cancel: cancelled })))
  await vi.advanceTimersByTimeAsync(0)
  expect(cancelled).toHaveBeenCalledTimes(1)
  expect(f.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid', 'oss.invalid'])
  expect(sha(Buffer.concat([await file.read(0, 524288), await file.read(524288, bytes.length - 524288)]))).toBe(revision.sha256)
})
it('keeps another backend and CDN independent of a remembered outage', async () => {
  const f = fixture({ origin: true }); f.object.mockRejectedValueOnce(network())
  value(await finish(f.cloud.managed(revision, context)))
  const other = fixture({ origin: true, session: f.session })
  other.endpoint.supabaseUrl = 'https://other-signer.invalid'
  other.api.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); other.requests.push(body)
    return Response.json({ status: 'ready', url: 'https://other-cdn.invalid/file', download_id: body.request_id,
      size_bytes: bytes.length, sha256: revision.sha256, origin_available: true })
  })
  value(await finish(other.cloud.managed(revision, context)))
  expect(other.requests[0]).not.toHaveProperty('origin')
  expect(other.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['other-cdn.invalid'])
})
it('keeps a healthy CDN download independent of a failing optional origin signer', async () => {
  const f = fixture({ origin: true, signerFails: true })
  value(await finish(f.cloud.managed(revision, context)))
  expect(f.requests).toHaveLength(1); expect(f.requests[0]).not.toHaveProperty('origin')
  expect(f.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid'])
  expect(f.committed).toHaveBeenCalledTimes(1)
})
it('requests an origin signature only after the CDN fails, using the existing reservation', async () => {
  const f = fixture({ origin: true }); let cdnFailed = false
  f.object.mockImplementationOnce(async () => { cdnFailed = true; throw network('ETIMEDOUT') })
  f.api.mockImplementationOnce(async () => {
    expect(cdnFailed).toBe(false)
    return Response.json({ status: 'ready', url: 'https://cdn.invalid/file', origin_available: true, download_id: 'reservation', size_bytes: bytes.length, sha256: revision.sha256 })
  })
  value(await finish(f.cloud.managed(revision, context)))
  expect(cdnFailed).toBe(true)
  expect(f.requests).toEqual([expect.objectContaining({ origin: true, request_id: 'reservation' })])
  expect(f.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid', 'oss.invalid'])
})
it('fails explicitly when the needed origin signature is refused after a real CDN failure', async () => {
  const f = fixture({ origin: true, signerFails: true }); f.object.mockRejectedValueOnce(network())
  const result = await finish(f.cloud.managed(revision, context))
  expect(result).toHaveProperty('error', expect.objectContaining({ status: 503, code: 'signing_failed' }))
  expect(f.requests).toHaveLength(14)
  expect(f.requests[1]).toMatchObject({ origin: true, request_id: f.requests[0]!.request_id })
  expect(f.object).toHaveBeenCalledTimes(1); expect(f.committed).not.toHaveBeenCalled()
})
it('does not ask for origin access to bypass an unexpired CDN refusal', async () => {
  const f = fixture({ origin: true }); f.object.mockResolvedValueOnce(new Response(null, { status: 403 }))
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.any(Error))
  expect(f.requests).toHaveLength(1); expect(f.object).toHaveBeenCalledTimes(1)
  expect(f.committed).not.toHaveBeenCalled()
})
it('restarts only the interrupted chunk at its existing offset after a response body connection failure', async () => {
  const f = fixture({ origin: true }); let reads = 0
  f.object.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(bytes.slice(0, 524288 + 20))
    else controller.error(network('UND_ERR_SOCKET'))
  } })))
  const file = value(await finish(f.cloud.managed(revision, context)))
  expect(f.object.mock.calls[1]?.[0]).toContain('oss.invalid')
  expect(new Headers(f.object.mock.calls[1]?.[1]?.headers).get('Range')).toBe('bytes=524288-')
  expect(f.cache.size).toBe(0)
  expect(sha(Buffer.concat([await file.read(0, 524288), await file.read(524288, bytes.length - 524288)]))).toBe(revision.sha256)
})
it('bounds connection retries with an old backend that has no origin URL and reports the failing hop safely', async () => {
  const f = fixture(); f.object.mockRejectedValue(new TypeError('fetch failed https://cdn.invalid/file?auth_key=do-not-log', { cause: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }))
  const result = await finish(f.cloud.managed(revision, context)); expect(f.object).toHaveBeenCalledTimes(13)
  expect(result).toHaveProperty('error', expect.objectContaining({ stage: 'cdn', host: 'cdn.invalid', code: 'ETIMEDOUT', elapsedMs: expect.any(Number), cause: expect.objectContaining({ code: 'ETIMEDOUT' }) }))
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('do-not-log')
  if ('error' in result) expect(String(result.error)).not.toContain('do-not-log')
  expect(f.committed).not.toHaveBeenCalled()
})
it.each(['connection', 'service'])('retains complete chunks after exhausting %s retries and resumes them on a later read', async failure => {
  const f = fixture(); let reads = 0
  f.object.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(bytes.slice(0, 524288 + 20))
    else controller.error(network('UND_ERR_SOCKET'))
  } }))).mockImplementation(async () => {
    if (failure === 'connection') throw network()
    return new Response(null, { status: 503 })
  })
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.any(Error))
  expect(f.cache.size).toBe(1); expect(f.committed).not.toHaveBeenCalled()
  f.object.mockImplementation(async (_url, init) => {
    const offset = Number(new Headers(init?.headers).get('Range')?.match(/bytes=(\d+)-/)?.[1] ?? 0)
    return new Response(bytes.slice(offset), { status: offset ? 206 : 200, headers: offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {} })
  })
  const resumed = value(await finish(f.cloud.managed(revision, context)))
  expect(f.object).toHaveBeenCalledTimes(14)
  expect(f.object.mock.calls.slice(1).map(([, init]) => new Headers(init?.headers).get('Range'))).toEqual(Array(13).fill('bytes=524288-'))
  expect(sha(Buffer.concat([await resumed.read(0, 524288), await resumed.read(524288, bytes.length - 524288)]))).toBe(revision.sha256)
})
it('redacts signed URLs from a non-connection failure without retrying it', async () => {
  const f = fixture(); f.object.mockRejectedValue(new TypeError('Invalid URL https://cdn.invalid/file?auth_key=do-not-log'))
  const result = await finish(f.cloud.managed(revision, context))
  expect(result).toHaveProperty('error', expect.objectContaining({ stage: 'cdn', code: 'DOWNLOAD_ERROR' }))
  expect(String('error' in result && result.error)).not.toContain('do-not-log')
  expect(f.object).toHaveBeenCalledTimes(1); expect(f.committed).not.toHaveBeenCalled()
})
it('never retries authentication refusals or mutating attachment operations', async () => {
  const f = fixture(); f.api.mockResolvedValue(Response.json({ error: 'denied', message: 'Access denied' }, { status: 403 }))
  const result = await finish(f.cloud.managed(revision, context)); expect(result).toHaveProperty('error', expect.objectContaining({ status: 403, code: 'denied' }))
  if ('error' in result) expect(result.error).toBeInstanceOf(AttachmentsError)
  expect(f.api).toHaveBeenCalledTimes(1); expect(f.object).not.toHaveBeenCalled()
  f.api.mockRejectedValue(network()); await expect(attachmentRequest(f.endpoint, 'commit', {})).rejects.toThrow('fetch failed')
  expect(f.api).toHaveBeenCalledTimes(2)
})
it('renews an expired signed URL once while keeping an unexpired 403 as a refusal', async () => {
  for (const expired of [true, false]) {
    const f = fixture({ expired }); f.object.mockResolvedValueOnce(new Response(null, { status: 403 }))
    const result = await finish(f.cloud.managed(revision, context))
    expect(f.requests).toHaveLength(expired ? 2 : 1)
    expect(f.object).toHaveBeenCalledTimes(expired ? 2 : 1)
    if (expired) { value(result); expect(f.requests[0]?.request_id).not.toBe(f.requests[1]?.request_id) }
    else expect(result).toHaveProperty('error', expect.any(Error))
  }
})
it('does not keep renewing or retrying a denied renewed capability', async () => {
  const f = fixture({ expired: true }); f.object.mockResolvedValue(new Response(null, { status: 403 }))
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.any(Error))
  expect(f.requests).toHaveLength(2); expect(f.object).toHaveBeenCalledTimes(2)
})
it('does not multiply exhausted signing retries inside the byte retry budget', async () => {
  const f = fixture({ expired: true }); f.object.mockImplementationOnce(async () => {
    f.api.mockRejectedValue(network()); return new Response(null, { status: 403 })
  })
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.objectContaining({ stage: 'signature' }))
  expect(f.api).toHaveBeenCalledTimes(14); expect(f.object).toHaveBeenCalledTimes(1)
})
it('bounds an exhausted lazy origin-signing request without retrying the byte operation again', async () => {
  const f = fixture({ origin: true }); f.object.mockImplementationOnce(async () => {
    f.api.mockRejectedValue(network()); throw network('ETIMEDOUT')
  })
  expect(await finish(f.cloud.managed(revision, context))).toHaveProperty('error', expect.objectContaining({ stage: 'signature' }))
  expect(f.api).toHaveBeenCalledTimes(14); expect(f.object).toHaveBeenCalledTimes(1)
  const origin = f.api.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)))
  expect(origin).toHaveLength(13)
  expect(origin.every(body => body.origin === true && body.request_id === f.requests[0]!.request_id)).toBe(true)
})
it('aborts a retry backoff immediately without another network attempt', async () => {
  const f = fixture({ origin: true }), abort = new AbortController(); f.object.mockRejectedValue(network())
  const work = f.cloud.managed(revision, { ...context, signal: abort.signal }).then(value => ({ value }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(0); abort.abort(new DOMException('Stopped', 'AbortError'))
  expect(await work).toHaveProperty('error', expect.objectContaining({ name: 'AbortError' }))
  expect(f.object).toHaveBeenCalledTimes(1); expect(f.committed).not.toHaveBeenCalled()
})
it('aborts signature backoff without waiting for the retry timer', async () => {
  const f = fixture(), abort = new AbortController(); f.api.mockRejectedValue(network())
  const work = f.cloud.managed(revision, { ...context, signal: abort.signal }).then(value => ({ value }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(0); abort.abort(new DOMException('Stopped', 'AbortError'))
  expect(await work).toHaveProperty('error', expect.objectContaining({ name: 'AbortError' }))
  expect(f.api).toHaveBeenCalledTimes(1); expect(f.object).not.toHaveBeenCalled()
})

it.each([408, 429, 500, 502, 503, 599].flatMap(status => ['file-resolve', 'file-download'].map(route => ({ status, route }))))('keeps $route pending through a 60-second HTTP $status outage and recovers automatically', async ({ status, route }) => {
  const f = fixture(), started = Date.now(), settled = vi.fn()
  f.api.mockImplementation(async () => Date.now() - started < 60_000
    ? Response.json({ error: 'temporary' }, { status }) : Response.json({ ...revision, status: 'ready' }))
  const work = attachmentRequest(f.endpoint, route, { request_id: 'same-reservation' }); void work.then(settled, settled)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(settled).not.toHaveBeenCalled()
  await vi.runAllTimersAsync()
  expect(await work).toMatchObject({ status: 'ready' })
  expect(settled).toHaveBeenCalledTimes(1)
  expect(Date.now() - started).toBeGreaterThanOrEqual(60_000)
  expect(Date.now() - started).toBeLessThanOrEqual(90_000)
  expect(new Set(f.api.mock.calls.map(([, init]) => String(init?.body))).size).toBe(1)
})
it('only rejects a persistent HTTP outage after the 90-second final retry', async () => {
  const f = fixture(), started = Date.now(), settled = vi.fn(), attempts: number[] = []
  f.api.mockImplementation(async () => { attempts.push(Date.now() - started); return Response.json({ error: 'busy' }, { status: 503 }) })
  const work = f.cloud.metadata(context).then(settled, error => { settled(error); return error })
  await vi.advanceTimersByTimeAsync(89_999)
  expect(settled).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(await work).toMatchObject({ status: 503, code: 'busy' })
  expect(settled).toHaveBeenCalledTimes(1)
  expect(attempts[0]).toBe(0); expect(attempts.at(-1)).toBe(90_000)
  expect(Math.max(...attempts.slice(1).map((time, i) => time - attempts[i]!))).toBeLessThanOrEqual(10_000)
})
it('recovers original bytes after a 60-second object-service outage without publishing partial bytes', async () => {
  const f = fixture(), started = Date.now()
  f.object.mockImplementation(async (_url, init) => {
    if (Date.now() - started < 60_000) return new Response(null, { status: 503 })
    const offset = Number(new Headers(init?.headers).get('Range')?.match(/bytes=(\d+)-/)?.[1] ?? 0)
    return new Response(bytes.slice(offset), { status: offset ? 206 : 200, headers: offset ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {} })
  })
  const work = f.cloud.managed(revision, context)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.committed).not.toHaveBeenCalled()
  const file = value(await finish(work))
  expect(file.size).toBe(bytes.length); expect(f.committed).toHaveBeenCalledTimes(1)
})
it('retries thumbnail responses and their bodies through the same window', async () => {
  const f = fixture({ thumbnail: true }), started = Date.now(), settled = vi.fn()
  f.object.mockImplementation(async () => Date.now() - started < 60_000
    // Byte-backed fixtures keep stream delivery on the fake clock, rather than Blob's native I/O queue.
    ? new Response(null, { status: 503 }) : new Response(new TextEncoder().encode('pixels'), { headers: { 'content-type': 'image/png' } }))
  const work = f.cloud.preview!({ ...revision, content_type: 'image/png' }, context, vi.fn()); void work.then(settled, settled)
  await vi.advanceTimersByTimeAsync(60_000); expect(settled).not.toHaveBeenCalled()
  const preview = value(await finish(work)); expect(preview).toBeInstanceOf(Blob)
  expect(f.object.mock.calls.every(([url]) => String(url).endsWith('/thumb.png'))).toBe(true)
})
it('never retries a thumbnail permission refusal', async () => {
  const f = fixture({ thumbnail: true }); f.object.mockResolvedValue(new Response(null, { status: 403 }))
  expect(await finish(f.cloud.preview!({ ...revision, content_type: 'image/png' }, context, vi.fn()))).toHaveProperty('error', expect.objectContaining({ status: 403 }))
  expect(f.object).toHaveBeenCalledTimes(1)
})
const pixels = new TextEncoder().encode('fixture thumbnail bytes')
const imageRevision = { ...revision, content_type: 'image/png' }
const imageResponse = () => new Response(pixels.slice(), { headers: { 'content-type': 'image/png' } })
it('falls back to the signed thumbnail on the original reservation and shares cooldown with original reads', async () => {
  const f = fixture({ origin: true, thumbnail: true }), full = vi.fn(async () => { throw new Error('Must not read the original') })
  f.object.mockRejectedValueOnce(network()).mockImplementation(async () => imageResponse())
  const preview = value(await finish(f.cloud.preview!(imageRevision, context, full))) as Blob
  expect(sha(new Uint8Array(await preview.arrayBuffer()))).toBe(sha(pixels))
  expect(f.requests).toHaveLength(2)
  expect(f.requests[1]).toMatchObject({ origin: true, request_id: f.requests[0]!.request_id, ref: context.ref, as: context.actor.actorId })
  expect(f.object.mock.calls.map(([url]) => [new URL(String(url)).host, new URL(String(url)).pathname])).toEqual([
    ['cdn.invalid', '/thumb.png'], ['oss.invalid', '/thumb.png'],
  ])
  expect(full).not.toHaveBeenCalled()
  const original = fixture({ origin: true, session: f.session })
  value(await finish(original.cloud.managed(revision, context)))
  expect(original.requests).toEqual([expect.objectContaining({ origin: true })])
  expect(original.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['oss.invalid'])
})
it('creates a fresh thumbnail reservation with origin:true in its first and only signing call during cooldown', async () => {
  const f = fixture({ origin: true }); f.object.mockRejectedValueOnce(network())
  value(await finish(f.cloud.managed(revision, context)))
  const thumbnail = fixture({ origin: true, thumbnail: true, session: f.session })
  thumbnail.object.mockImplementation(async () => imageResponse())
  const full = vi.fn(async () => { throw new Error('Must not read the original') })
  const preview = value(await finish(thumbnail.cloud.preview!(imageRevision, context, full))) as Blob
  expect(thumbnail.requests).toEqual([expect.objectContaining({ origin: true })])
  expect(thumbnail.requests[0]!.request_id).not.toBe(f.requests[0]!.request_id)
  expect(thumbnail.object.mock.calls.map(([url]) => [new URL(String(url)).host, new URL(String(url)).pathname])).toEqual([['oss.invalid', '/thumb.png']])
  expect(sha(new Uint8Array(await preview.arrayBuffer()))).toBe(sha(pixels)); expect(full).not.toHaveBeenCalled()
})
it('bounds a stalled thumbnail body before switching to the separately signed image', async () => {
  const f = fixture({ origin: true, thumbnail: true }), full = vi.fn(async () => { throw new Error('Must not read the original') })
  f.object.mockResolvedValueOnce(new Response(new ReadableStream(), { headers: { 'content-type': 'image/png' } }))
  f.object.mockImplementation(async () => imageResponse())
  const preview = value(await finish(f.cloud.preview!(imageRevision, context, full))) as Blob
  expect(f.object.mock.calls[0]![1]!.signal!.aborted).toBe(true)
  expect(f.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid', 'oss.invalid'])
  expect(sha(new Uint8Array(await preview.arrayBuffer()))).toBe(sha(pixels)); expect(full).not.toHaveBeenCalled()
})
it('redacts an invalid direct thumbnail URL without reading the original', async () => {
  const f = fixture({ origin: true, thumbnail: true }), api = f.api.getMockImplementation()!
  f.object.mockRejectedValueOnce(network())
  f.api.mockImplementation(async (url, init) => {
    const response = await api(url, init), body = JSON.parse(String(init?.body))
    if (!body.origin) return response
    return Response.json({ ...await response.json(), thumb_url: 'not a URL?auth_key=do-not-log' })
  })
  const full = vi.fn(async () => { throw new Error('Must not read the original') })
  const result = await finish(f.cloud.preview!(imageRevision, context, full))
  expect(result).toHaveProperty('error', expect.objectContaining({ message: 'Invalid file thumbnail URL' }))
  expect(String('error' in result && result.error)).not.toContain('do-not-log')
  expect(full).not.toHaveBeenCalled(); expect(f.object).toHaveBeenCalledTimes(1)
})
it.each(['missing', 'null', 'empty'] as const)('tries one CDN thumbnail for a %s direct thumbnail without reading the original', async missing => {
  const f = fixture({ origin: true, thumbnail: true }), api = f.api.getMockImplementation()!
  f.object.mockRejectedValueOnce(network()).mockImplementation(async () => imageResponse())
  f.api.mockImplementation(async (url, init) => {
    const response = await api(url, init), body = JSON.parse(String(init?.body))
    if (!body.origin) return response
    const row = await response.json()
    if (missing === 'missing') delete row.thumb_url
    else row.thumb_url = missing === 'null' ? null : ''
    return Response.json(row)
  })
  const full = vi.fn(async () => { throw new Error('Must not read the original') })
  const preview = value(await finish(f.cloud.preview!(imageRevision, context, full))) as Blob
  expect(sha(new Uint8Array(await preview.arrayBuffer()))).toBe(sha(pixels))
  expect(f.requests).toHaveLength(3)
  expect(f.requests.map(request => request.origin === true)).toEqual([false, true, false])
  expect(new Set(f.requests.map(request => request.request_id)).size).toBe(1)
  expect(f.object.mock.calls.map(([url]) => [new URL(String(url)).host, new URL(String(url)).pathname])).toEqual([
    ['cdn.invalid', '/thumb.png'], ['cdn.invalid', '/thumb.png'],
  ])
  expect(full).not.toHaveBeenCalled()
  const next = fixture({ origin: true, session: f.session })
  value(await finish(next.cloud.managed(revision, context)))
  expect(next.requests).toEqual([expect.objectContaining({ origin: true })])
})
it('recovers a direct-first thumbnail from an older signer with one CDN attempt on the same reservation', async () => {
  const original = fixture({ origin: true }); original.object.mockRejectedValueOnce(network())
  value(await finish(original.cloud.managed(revision, context)))
  const f = fixture({ origin: true, thumbnail: true, session: original.session }), api = f.api.getMockImplementation()!
  f.api.mockImplementation(async (url, init) => {
    const response = await api(url, init), body = JSON.parse(String(init?.body)), row = await response.json()
    if (body.origin) { row.thumb_url = null; row.expires_at = new Date(Date.parse(row.expires_at) - 500).toISOString() }
    return Response.json(row)
  })
  f.object.mockImplementation(async () => imageResponse())
  const full = vi.fn(async () => { throw new Error('Must not read the original') })
  const preview = value(await finish(f.cloud.preview!(imageRevision, context, full))) as Blob
  expect(sha(new Uint8Array(await preview.arrayBuffer()))).toBe(sha(pixels))
  expect(f.requests.map(request => request.origin === true)).toEqual([true, false])
  expect(new Set(f.requests.map(request => request.request_id)).size).toBe(1)
  expect(f.requests[0]!.request_id).not.toBe(original.requests[0]!.request_id)
  expect(f.object.mock.calls.map(([url]) => [new URL(String(url)).host, new URL(String(url)).pathname])).toEqual([['cdn.invalid', '/thumb.png']])
  expect(full).not.toHaveBeenCalled()
})
it('stops after one compatibility CDN timeout without looping back to origin or reading the original', async () => {
  const f = fixture({ origin: true, thumbnail: true }), api = f.api.getMockImplementation()!, started = Date.now()
  f.api.mockImplementation(async (url, init) => {
    const response = await api(url, init), body = JSON.parse(String(init?.body))
    return body.origin ? Response.json({ ...await response.json(), thumb_url: null }) : response
  })
  f.object.mockRejectedValueOnce(network()).mockImplementation(() => new Promise(() => {}))
  const full = vi.fn(async () => { throw new Error('Must not read the original') })
  expect(await finish(f.cloud.preview!(imageRevision, context, full))).toHaveProperty('error', expect.objectContaining({ stage: 'cdn', code: 'ETIMEDOUT' }))
  expect(Date.now() - started).toBe(3_500)
  expect(f.requests.map(request => request.origin === true)).toEqual([false, true, false])
  expect(f.object).toHaveBeenCalledTimes(2); expect(full).not.toHaveBeenCalled()
})
it('fails explicitly when neither the direct signer nor the CDN signer has a thumbnail', async () => {
  const original = fixture({ origin: true }); original.object.mockRejectedValueOnce(network())
  value(await finish(original.cloud.managed(revision, context)))
  const f = fixture({ origin: true, session: original.session })
  const full = vi.fn(async () => { throw new Error('Must not read the original') })
  expect(await finish(f.cloud.preview!(imageRevision, context, full))).toHaveProperty('error', expect.objectContaining({ message: 'Direct file thumbnail is unavailable' }))
  expect(f.requests.map(request => request.origin === true)).toEqual([true, false])
  expect(f.object).not.toHaveBeenCalled(); expect(full).not.toHaveBeenCalled()
})
it('does not bypass a compatibility CDN permission refusal', async () => {
  const original = fixture({ origin: true }); original.object.mockRejectedValueOnce(network())
  value(await finish(original.cloud.managed(revision, context)))
  const f = fixture({ origin: true, thumbnail: true, session: original.session }), api = f.api.getMockImplementation()!
  f.api.mockImplementation(async (url, init) => {
    const response = await api(url, init), body = JSON.parse(String(init?.body))
    return body.origin ? Response.json({ ...await response.json(), thumb_url: null }) : response
  })
  f.object.mockResolvedValue(new Response(null, { status: 403 }))
  const full = vi.fn(async () => { throw new Error('Must not read the original') })
  expect(await finish(f.cloud.preview!(imageRevision, context, full))).toHaveProperty('error', expect.objectContaining({ status: 403 }))
  expect(f.requests.map(request => request.origin === true)).toEqual([true, false])
  expect(f.object).toHaveBeenCalledTimes(1); expect(full).not.toHaveBeenCalled()
})
it.each(['reservation', 'expiry', 'revision'] as const)('rejects a changed %s in the thumbnail origin response', async changed => {
  const f = fixture({ origin: true, thumbnail: true }), api = f.api.getMockImplementation()!
  f.object.mockRejectedValueOnce(network())
  f.api.mockImplementation(async (url, init) => {
    const response = await api(url, init), body = JSON.parse(String(init?.body))
    if (!body.origin) return response
    const row = await response.json()
    if (changed === 'reservation') row.download_id = 'a-different-reservation'
    if (changed === 'expiry') row.expires_at = new Date(Date.now() + 120_000).toISOString()
    if (changed === 'revision') row.sha256 = '0'.repeat(64)
    return Response.json(row)
  })
  const full = vi.fn(async () => { throw new Error('Must not read the original') })
  expect(await finish(f.cloud.preview!(imageRevision, context, full))).toHaveProperty('error', expect.any(Error))
  expect(f.object).toHaveBeenCalledTimes(1); expect(full).not.toHaveBeenCalled()
})
it('does not turn a valid thumbnail refusal into origin access or remembered CDN failure', async () => {
  const f = fixture({ origin: true, thumbnail: true }), full = vi.fn(async () => { throw new Error('Must not read the original') })
  f.object.mockResolvedValueOnce(new Response(null, { status: 403 }))
  expect(await finish(f.cloud.preview!(imageRevision, context, full))).toHaveProperty('error', expect.objectContaining({ status: 403 }))
  expect(f.requests).toHaveLength(1); expect(full).not.toHaveBeenCalled()
  const next = fixture({ origin: true, thumbnail: true, session: f.session })
  next.object.mockImplementation(async () => imageResponse())
  value(await finish(next.cloud.preview!(imageRevision, context, full)))
  expect(next.requests[0]).not.toHaveProperty('origin')
  expect(next.object.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(['cdn.invalid'])
})
it.each(['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'])('recovers browser connection failures: %s', async message => {
  const f = fixture(); f.api.mockRejectedValueOnce(new TypeError(message))
  value(await finish(f.cloud.managed(revision, context)))
  expect(f.committed).toHaveBeenCalledTimes(1)
})
