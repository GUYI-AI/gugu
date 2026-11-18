import { afterEach, expect, it, vi } from 'vitest'
import { uploadAttachmentPlan } from '@gugu/core/cloud/attachmentsApi'
import { AttachmentDeadlineError, ATTACHMENT_UPLOAD_IDLE_MS, ATTACHMENT_UPLOAD_START_MS, runAttachmentStage } from '@gugu/core/cloud/attachmentDeadline'
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
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  const endpoint = await headlessEndpoint()

  await uploadAttachmentPlan(endpoint, { url, fields: { key: 'pending' }, max_bytes: 100 }, {
    bytes: new Blob(['attachment']), name: 'file.txt', contentType: 'text/plain',
  })

  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ method: 'POST' }))
  const sent = fetch.mock.calls[0]![1]
  const headers = new Headers(sent?.headers)
  const bytes = await new Response(sent?.body).arrayBuffer()
  expect(headers.get('content-length')).toBe(String(bytes.byteLength))
  const form = await new Response(bytes, { headers }).formData()
  expect(form.get('key')).toBe('pending')
  expect(await (form.get('file') as File).text()).toBe('attachment')
  expect(request).not.toHaveBeenCalled()
})

async function uploadPutWithDeadline(observe: (loaded: number) => void) {
  const endpoint = await headlessEndpoint()
  const bytes = new Blob([new Uint8Array(256 * 1024)])
  return runAttachmentStage('upload', (signal, _cap, progress) =>
    uploadAttachmentPlan(endpoint, { url, method: 'PUT', fields: {}, max_bytes: bytes.size }, {
      bytes, name: 'slow.bin', contentType: 'application/octet-stream',
    }, false, ({ loaded, total }) => { observe(loaded); progress(loaded, total) }, signal))
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

it('aborts a headless upload when the HTTP client stops consuming its body', async () => {
  vi.useFakeTimers()
  const readFirst = Promise.withResolvers<void>()
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = new Response(init.body).body!.getReader()
    try {
      await body.read()
      const signal = init.signal!
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        readFirst.resolve()
      })
    } finally { await body.cancel() }
  })
  const progress = vi.fn()
  const uploaded = uploadPutWithDeadline(progress)
  const failed = expect(uploaded).rejects.toBeInstanceOf(AttachmentDeadlineError)
  await readFirst.promise
  expect(progress).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_IDLE_MS)
  await failed
})
