import { afterEach, expect, it, vi } from 'vitest'
import { uploadAttachmentPlan } from '@gugu/core/cloud/attachmentsApi'
import { AttachmentDeadlineError, ATTACHMENT_UPLOAD_IDLE_MS, ATTACHMENT_UPLOAD_START_MS } from '@gugu/core/cloud/attachmentDeadline'
import { net } from '../../../../apps/desktop/electron/server/server-electron-shim'
import { hostAttachmentsEndpoint } from '../../../../apps/desktop/electron/attachmentUploadTransport'

vi.mock('electron', () => import('../../../../apps/desktop/electron/server/server-electron-shim'))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const url = 'https://store.test/attachment'
const headlessEndpoint = () => hostAttachmentsEndpoint({
  supabaseUrl: 'https://db.test', anonKey: 'anon', getAccessToken: async () => 'token',
}, net.fetch, true)

it('uploads attachments on the headless server through net.fetch without reaching net.request', async () => {
  const request = vi.spyOn(net, 'request')
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, sent) => {
    const headers = new Headers(sent?.headers)
    const bytes = await new Response(sent?.body).arrayBuffer()
    expect(headers.get('content-length')).toBe(String(bytes.byteLength))
    const form = await new Response(bytes, { headers }).formData()
    expect(form.get('key')).toBe('pending')
    expect(await (form.get('file') as File).text()).toBe('attachment')
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetch)
  const endpoint = await headlessEndpoint()

  await uploadAttachmentPlan(endpoint, { url, fields: { key: 'pending' }, max_bytes: 100 }, {
    bytes: new Blob(['attachment']), name: 'file.txt', contentType: 'text/plain',
  })

  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ method: 'POST' }))
  expect(request).not.toHaveBeenCalled()
})

async function uploadPutWithDeadline(observe: (loaded: number) => void) {
  const endpoint = await headlessEndpoint()
  const bytes = new Blob([new Uint8Array(256 * 1024)])
  return uploadAttachmentPlan(endpoint, { url, method: 'PUT', fields: {}, max_bytes: bytes.size }, {
    bytes, name: 'slow.bin', contentType: 'application/octet-stream',
  }, false, ({ loaded }) => observe(loaded))
}

it('keeps a slow headless upload alive beyond the first-progress deadline while the body is consumed', async () => {
  vi.useFakeTimers()
  const readFirst = Promise.withResolvers<void>()
  const interval = ATTACHMENT_UPLOAD_IDLE_MS - 5_000
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = new Response(init.body).body!.getReader()
    try {
      while (!(await body.read()).done) {
        readFirst.resolve()
        await new Promise(resolve => setTimeout(resolve, interval))
      }
      return new Response(null, { status: 200 })
    } finally { await body.cancel() }
  })
  const progress = vi.fn()
  const uploaded = uploadPutWithDeadline(progress)
  const finished = expect(uploaded).resolves.toBeUndefined()
  await readFirst.promise
  await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_START_MS)
  expect(progress.mock.calls.length).toBeGreaterThan(1)
  await vi.runAllTimersAsync()
  await finished
  expect(progress).toHaveBeenLastCalledWith(256 * 1024)
})

it.each([
  ['before its first byte', false, ATTACHMENT_UPLOAD_START_MS],
  ['after its first chunk', true, ATTACHMENT_UPLOAD_IDLE_MS],
])('aborts a headless upload stalled %s', async (_phase, readChunk, timeout) => {
  vi.useFakeTimers()
  const stalled = Promise.withResolvers<AbortSignal>()
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = new Response(init.body).body!.getReader()
    try {
      if (readChunk) await body.read()
      const signal = init.signal!
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        stalled.resolve(signal)
      })
    } finally { await body.cancel() }
  })
  const progress = vi.fn()
  const uploaded = uploadPutWithDeadline(progress)
  const failed = expect(uploaded).rejects.toBeInstanceOf(AttachmentDeadlineError)
  const signal = await stalled.promise
  expect(progress).toHaveBeenCalledTimes(readChunk ? 1 : 0)
  await vi.advanceTimersByTimeAsync(timeout - 1)
  expect(signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await failed
})

it('bounds the wait for storage after the body of an individual part is consumed', async () => {
  vi.useFakeTimers()
  const waiting = Promise.withResolvers<AbortSignal>()
  const partBytes = 256 * 1024
  const bytes = new Blob([new Uint8Array(2 * partBytes)])
  const parts = [{ n: 1, bytes: partBytes, url: `${url}/1`, headers: {} }, { n: 2, bytes: partBytes, url: `${url}/2`, headers: {} }]
  vi.stubGlobal('fetch', async (address: string, init: RequestInit) => {
    if (address.endsWith('/upload-parts')) {
      const { done } = JSON.parse(String(init.body))
      return Response.json(done.length ? { done, todo: [] } : { done: [], todo: parts })
    }
    expect((await new Response(init.body).arrayBuffer()).byteLength).toBe(partBytes)
    if (address === parts[1]!.url) return new Response(null, { status: 200 })
    const signal = init.signal!
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      waiting.resolve(signal)
    })
  })
  const endpoint = await headlessEndpoint()
  const uploaded = uploadAttachmentPlan(endpoint, { url, fields: {}, max_bytes: bytes.size,
    staging_key: 'pending', parts: { part_bytes: partBytes, count: 2 } }, { bytes, name: 'slow.bin', contentType: 'application/octet-stream' })
  const failed = expect(uploaded).rejects.toBeInstanceOf(AttachmentDeadlineError)
  const signal = await waiting.promise
  await vi.advanceTimersByTimeAsync(23_999) // 20 s plus one 256 KiB part at 64 KiB/s.
  expect(signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await failed
})
