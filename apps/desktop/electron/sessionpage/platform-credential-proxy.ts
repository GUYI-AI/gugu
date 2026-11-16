import type { IncomingMessage, IncomingHttpHeaders, ServerResponse } from 'node:http'
import { finished, pipeline, Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { hostFetch } from '@gugu/core/shared/hostFetch'
import { PlatformStreamTimingRecorder, type PlatformStreamTiming } from './platform-stream-timing'

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
/**
 * The host fetch owns these: it sets the target host and body length, negotiates the encodings it can decode, and
 * hands back a decoded body. Forwarding the gateway's `content-encoding`/`content-length` with decoded bytes would
 * make the harness decode twice or cut the stream short.
 */
const FETCH_OWNED_REQUEST = new Set(['host', 'content-length', 'accept-encoding'])
const FETCH_OWNED_RESPONSE = new Set(['content-encoding', 'content-length'])

export interface CredentialProxyOptions {
  upstream: () => URL
  localOnlyHeaders: ReadonlySet<string>
  credential: () => Promise<string>
  refresh: (rejected: string) => Promise<string>
  warn: (event: { kind: 'connection' | 'stream'; status?: number; code?: string }) => void
  streamTiming?: (timing: PlatformStreamTiming) => void
}

/** The deadline bounds the caller, not the shared rotation: a late successful issue remains usable. */
export async function withinCredentialDeadline<T>(pending: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Platform credential refresh timed out')), timeoutMs)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function upstreamHeaders(headers: IncomingHttpHeaders, options: CredentialProxyOptions, token: string) {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (value === undefined || HOP_HEADERS.has(key) || FETCH_OWNED_REQUEST.has(key) || options.localOnlyHeaders.has(key)) continue
    // A Claude helper value can appear in BOTH headers. Neither local credential may escape.
    if (key === 'authorization' || key === 'x-api-key') continue
    for (const one of Array.isArray(value) ? value : [value]) result.append(name, one)
  }
  result.set('authorization', `Bearer ${token}`)
  if (headers['x-api-key'] !== undefined) result.set('x-api-key', token)
  return result
}

/** What the runtime says about a request that got no answer: an errno (undici's cause) or Chromium's `net::ERR_*`. */
function transportCode(error: unknown): string | undefined {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 5; at = at.cause, depth++) {
    const code = (at as NodeJS.ErrnoException).code
    if (typeof code === 'string') return code
    const chromium = /\bnet::ERR_[A-Z0-9_]+/.exec(at.message)?.[0]
    if (chromium) return chromium
  }
  return undefined
}

/**
 * Forwards one harness request to the gateway through the host fetch, so it reaches the gateway the way every other
 * host request does (on desktop: Chromium, which honors the system proxy and certificate store).
 * Replay only an unaccepted 401, once. Request bytes are retained; response SSE is never buffered.
 */
export async function proxyPlatformCredentialRequest(
  request: IncomingMessage, response: ServerResponse, options: CredentialProxyOptions,
): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const body = Buffer.concat(chunks)
  let upstreamAbort: AbortController | undefined
  let harnessGone = response.destroyed
  let gatewayCut = false
  finished(response, (error) => {
    if (!error) return
    if (!gatewayCut) harnessGone = true
    upstreamAbort?.abort()
  })
  const send = async (token: string, retried: boolean): Promise<void> => {
    if (harnessGone) return
    const startedAt = performance.now()
    const wallStart = Date.now()
    const abort = upstreamAbort = new AbortController()
    let upstreamResponse: Response
    try {
      upstreamResponse = await hostFetch(options.upstream(), {
        method: request.method,
        headers: upstreamHeaders(request.headers, options, token),
        body: body.length ? body : undefined,
        signal: abort.signal,
        redirect: 'manual',
      })
    } catch (error) {
      if (harnessGone) return
      options.warn({ kind: 'connection', code: transportCode(error) })
      if (!response.headersSent) response.writeHead(502).end()
      else response.destroy()
      return
    }
    if (upstreamResponse.status === 401 && !retried) {
      // No inference was accepted and no response headers/bytes have reached the harness.
      void upstreamResponse.body?.cancel().catch(() => {})
      let next: string
      try {
        next = await options.refresh(token)
      } catch {
        if (!response.headersSent && !harnessGone) {
          response.writeHead(503, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Platform credential refresh failed' } }))
        }
        return
      }
      return send(next, true)
    }
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of upstreamResponse.headers) {
      const key = name.toLowerCase()
      if (HOP_HEADERS.has(key) || FETCH_OWNED_RESPONSE.has(key)) continue
      const earlier = headers[key]
      headers[key] = earlier === undefined ? value : [earlier, value].flat()
    }
    response.writeHead(upstreamResponse.status, headers)
    if (!upstreamResponse.body) {
      response.end()
      return
    }
    const isSse = /^text\/event-stream\b/i.test(upstreamResponse.headers.get('content-type') ?? '')
    const observer = isSse && options.streamTiming
      ? new PlatformStreamTimingRecorder(true, () => performance.now(), wallStart, startedAt)
      : undefined
    const upstreamBody = Readable.fromWeb(upstreamResponse.body as unknown as NodeWebReadableStream<Uint8Array>)
    if (observer) upstreamBody.on('data', (chunk: Uint8Array) => observer.data(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
    let complete = false
    upstreamBody.once('end', () => { complete = true })
    upstreamBody.once('error', () => { if (!harnessGone) gatewayCut = true })
    pipeline(upstreamBody, response, (error) => {
      if (observer) options.streamTiming?.(observer.finish(!error && complete))
      if (!error) return
      abort.abort()
      if (gatewayCut) options.warn({ kind: 'stream', status: upstreamResponse.status })
    })
  }
  await send(await options.credential(), false)
}
