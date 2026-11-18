import { net } from 'electron'
import { accountAttachmentsEndpoint, type AttachmentUploadTransport } from '@gugu/core/cloud/attachmentsApi'

export async function hostAttachmentsEndpoint(
  account: Parameters<typeof accountAttachmentsEndpoint>[0],
  fetchImpl: typeof fetch,
  headless: boolean,
) {
  const endpoint = await accountAttachmentsEndpoint(account, fetchImpl)
  if (!headless) endpoint.upload = nativeAttachmentUpload
  return endpoint
}

/** Chromium reports transferred bytes on main's requests, the same progress the renderer previously read from XHR. */
const nativeAttachmentUpload: AttachmentUploadTransport = async (url, init, onProgress) => {
  init.signal?.throwIfAborted()
  const body = new Request(url, { method: init.method, headers: init.headers, body: init.body })
  const bytes = Buffer.from(await body.arrayBuffer())
  init.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: init.method, redirect: 'error' })
    const report = () => {
      const progress = request.getUploadProgress()
      if (progress.active && progress.started) onProgress?.({ loaded: progress.current, total: progress.total })
    }
    const timer = setInterval(report, 200)
    const cleanup = () => { clearInterval(timer); init.signal?.removeEventListener('abort', abort) }
    const fail = (error: unknown) => { cleanup(); reject(error) }
    const abort = () => { request.abort(); fail(init.signal?.reason ?? new Error('Attachment upload cancelled')) }
    init.signal?.addEventListener('abort', abort, { once: true })
    request.on('error', fail)
    request.on('response', response => {
      response.on('error', fail)
      response.on('data', () => {})
      response.on('end', () => {
        cleanup()
        onProgress?.({ loaded: bytes.length, total: bytes.length })
        resolve({ status: response.statusCode })
      })
    })
    try {
      for (const [name, value] of body.headers) request.setHeader(name, value)
      request.end(bytes)
    } catch (error) { request.abort(); fail(error) }
  })
}
