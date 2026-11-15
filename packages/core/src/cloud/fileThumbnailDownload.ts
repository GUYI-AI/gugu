import { createFileDownloadTransport, type FileDownloadSession } from './fileDownloadRouting'
import { retryFileDownload } from './fileDownloadRetry'

type Thumbnail = { thumb_url?: string | null; expires_at?: string; origin_available?: boolean }
type SignedThumbnail = { lease: Thumbnail; direct: boolean }

/** A fallback thumbnail remains a display-only capability; it never opens the original. */
export async function readFileThumbnail(initial: SignedThumbnail, sign: (renew: boolean, origin: boolean) => Promise<SignedThumbnail>,
  fetcher: () => Promise<typeof fetch>, session: FileDownloadSession, signal?: AbortSignal): Promise<Blob> {
  let signed = initial, renewed = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const target = () => {
    if (typeof signed.lease.thumb_url !== 'string' || !signed.lease.thumb_url) throw new Error('Direct file thumbnail is unavailable')
    let url: URL
    try { url = new URL(signed.lease.thumb_url) } catch { throw new Error('Invalid file thumbnail URL') }
    if (signed.direct && (url.protocol !== 'https:' || url.username || url.password)) throw new Error('Invalid direct file thumbnail')
    return { stage: signed.direct ? 'oss' as const : 'cdn' as const, url: signed.lease.thumb_url }
  }
  const transport = createFileDownloadTransport(target, fetcher, session, signal)
  const reset = () => { transport.cancel(reader); reader = undefined }
  try {
    return await retryFileDownload(target, async () => {
      let response = await transport.open()
      const expires = Date.parse(signed.lease.expires_at ?? '')
      if (response.status === 403 && !renewed && Number.isFinite(expires) && expires <= Date.now()) {
        void response.body?.cancel().catch(() => undefined); reset(); renewed = true
        signed = await sign(true, signed.direct)
        response = await transport.open()
      }
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => undefined)
        return transport.refuse(Object.assign(new Error(`File preview HTTP ${response.status}`), { status: response.status }))
      }
      const type = response.headers.get('content-type') ?? ''
      if (!type.toLowerCase().startsWith('image/')) {
        void response.body?.cancel().catch(() => undefined)
        throw new Error('Invalid file preview image')
      }
      reader = response.body.getReader()
      const parts: Uint8Array<ArrayBuffer>[] = []
      for (;;) {
        const part = await transport.read(reader)
        if (part.done) break
        parts.push(new Uint8Array(part.value))
      }
      return new Blob(parts, { type })
    }, signal, async () => {
      reset()
      if (!signed.direct && signed.lease.origin_available === true) signed = await sign(false, true)
      target() // A missing direct thumbnail fails here, never as a request for the original.
    })
  } finally { reset() }
}
