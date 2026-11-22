import { egress } from '@gugu/core/shared/egress'
import { accountAttachmentsEndpoint, type AttachmentUploadTransport } from '@gugu/core/cloud/attachmentsApi'

/** Every host (desktop or headless) uploads through the egress, so a proxy applies to the bytes as to every other request. */
export async function hostAttachmentsEndpoint(account: Parameters<typeof accountAttachmentsEndpoint>[0]) {
  const endpoint = await accountAttachmentsEndpoint(account, egress.fetch)
  endpoint.upload = streamedAttachmentUpload
  return endpoint
}

/** Progress counts the bytes the HTTP client has pulled; the response header deadline is the attachment stage's. */
const streamedAttachmentUpload: AttachmentUploadTransport = async (url, init, onProgress) => {
  const { method, signal } = init
  signal?.throwIfAborted()
  const request = new Request(url, init)
  const blob = init.body instanceof Blob ? init.body : await request.blob()
  request.headers.set('content-length', String(blob.size))
  let loaded = 0
  // With no prefetch, a pull means the HTTP client is ready for another chunk.
  const body = new ReadableStream({
    async pull(controller) {
      if (loaded === blob.size) return controller.close()
      signal?.throwIfAborted()
      const chunk = new Uint8Array(await blob.slice(loaded, loaded + 64 * 1024).arrayBuffer())
      signal?.throwIfAborted()
      controller.enqueue(chunk)
      loaded += chunk.byteLength
      onProgress?.({ loaded, total: blob.size })
    },
  }, { highWaterMark: 0 })
  const response = await egress.fetch(url, { method, body, headers: request.headers, signal, duplex: 'half', timeoutMs: 0 } as RequestInit & { timeoutMs: number })
  await response.body?.cancel()
  return { status: response.status }
}
