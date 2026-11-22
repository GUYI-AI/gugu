import type { IncomingMessage, IncomingHttpHeaders, ServerResponse } from 'node:http'
import { finished, pipeline, Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { egress, EgressError, egressErrorText } from '@gugu/core/shared/egress'
import { PlatformStreamTimingRecorder, type PlatformStreamTiming } from './platform-stream-timing'
import { PlatformHttpErrorRecorder, type PlatformHttpErrorDiagnostic } from './platform-http-error'

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
/**
 * The host fetch owns these: it sets the target host and body length, negotiates the encodings it can decode, and
 * hands back a decoded body. Forwarding the gateway's `content-encoding`/`content-length` with decoded bytes would
 * make the harness decode twice or cut the stream short.
 */
const FETCH_OWNED_REQUEST = new Set(['host', 'content-length', 'accept-encoding'])
const FETCH_OWNED_RESPONSE = new Set(['content-encoding', 'content-length'])
/** undici rejects a request carrying `expect` ("expect header not supported"); every other harness header is forwarded. */
const RELAY_UNSUPPORTED_REQUEST = new Set(['expect'])

export interface CredentialProxyOptions {
  upstream: () => URL
  localOnlyHeaders: ReadonlySet<string>
  credential: () => Promise<string>
  refresh?: (rejected: string) => Promise<string>
  credentialHeaders?: (token: string) => Record<string, string>
  maxRequestBytes?: number
  refreshForbidden?: boolean
  refusal?: (status: number, retried: boolean) => Promise<{ code: string; reason_code?: string; message: string } | null>
  refusalError?: (error: unknown) => { code: string; reason_code?: string; message: string } | null
  warn: (event: { kind: 'connection' | 'stream'; status?: number; code?: string; headerNames?: string[] }) => void
  streamTiming?: (timing: PlatformStreamTiming) => void
  httpError?: (diagnostic: PlatformHttpErrorDiagnostic) => void
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
    if (value === undefined || HOP_HEADERS.has(key) || FETCH_OWNED_REQUEST.has(key)
      || RELAY_UNSUPPORTED_REQUEST.has(key) || options.localOnlyHeaders.has(key)) continue
    // A Claude helper value can appear in BOTH headers. Neither local credential may escape.
    if (key === 'authorization' || key === 'x-api-key') continue
    for (const one of Array.isArray(value) ? value : [value]) result.append(name, one)
  }
  if (options.credentialHeaders) for (const [name, value] of Object.entries(options.credentialHeaders(token))) result.set(name, value)
  else {
    result.set('authorization', `Bearer ${token}`)
    if (headers['x-api-key'] !== undefined) result.set('x-api-key', token)
  }
  return result
}

/**
 * Forwards one harness request to the gateway through egress, using the installed host's proxy and trust policy.
 * Replay only an unaccepted 401, once. Request bytes are retained; response SSE is never buffered.
 */
export async function proxyPlatformCredentialRequest(
  request: IncomingMessage, response: ServerResponse, options: CredentialProxyOptions,
): Promise<void> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (options.maxRequestBytes !== undefined && bytes > options.maxRequestBytes) { response.writeHead(413).end(); return }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
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
      upstreamResponse = await egress.fetch(options.upstream(), {
        method: request.method,
        headers: upstreamHeaders(request.headers, options, token),
        body: body.length ? body : undefined,
        signal: abort.signal,
        redirect: 'error', // A gateway redirect is unexpected; never follow it with platform credentials.
        timeoutMs: 0, // Model inference may legitimately take longer than an ordinary REST request.
      })
    } catch (error) {
      if (harnessGone) return
      options.warn({ kind: 'connection', code: error instanceof EgressError ? error.kind : undefined, headerNames: Object.keys(request.headers).sort() })
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: {
          type: 'api_error', message: error instanceof EgressError ? egressErrorText(error.kind) : '模型请求未获得响应，请查看任务日志。',
        } }))
      }
      else response.destroy()
      return
    }
    const status = upstreamResponse.status
    const refuse = (refusal: { code: string; reason_code?: string; message: string }) => {
      if (harnessGone || response.headersSent) return
      response.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', ...refusal } }))
    }
    if (options.refusal && (status === 401 || status === 403)) {
      let refusal: Awaited<ReturnType<NonNullable<CredentialProxyOptions['refusal']>>>
      try { refusal = await options.refusal(status, retried) }
      catch {
        void upstreamResponse.body?.cancel().catch(() => {})
        if (!response.headersSent && !harnessGone) response.writeHead(503).end()
        else response.destroy()
        return
      }
      if (refusal) {
        void upstreamResponse.body?.cancel().catch(() => {})
        refuse(refusal)
        return
      }
    }
    if ((status === 401 || (status === 403 && options.refreshForbidden)) && !retried && options.refresh) {
      // No inference was accepted and no response headers/bytes have reached the harness.
      void upstreamResponse.body?.cancel().catch(() => {})
      let next: string
      try {
        next = await options.refresh(token)
      } catch (error) {
        if (!response.headersSent && !harnessGone) {
          const refusal = options.refusalError?.(error)
          if (refusal) { refuse(refusal); return }
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
    // `headers` already omits content-encoding: the fetch hands back decoded bytes, which the recorder can read.
    const httpError = upstreamResponse.status === 400 && options.httpError
      ? new PlatformHttpErrorRecorder(headers) : undefined
    const upstreamBody = Readable.fromWeb(upstreamResponse.body as unknown as NodeWebReadableStream<Uint8Array>)
    const chunkBuffer = (chunk: Uint8Array) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (httpError) upstreamBody.on('data', (chunk: Uint8Array) => httpError.data(chunkBuffer(chunk)))
    if (observer) upstreamBody.on('data', (chunk: Uint8Array) => observer.data(chunkBuffer(chunk)))
    let complete = false
    upstreamBody.once('end', () => { complete = true })
    upstreamBody.once('error', () => { if (!harnessGone) gatewayCut = true })
    pipeline(upstreamBody, response, (error) => {
      try {
        if (httpError) options.httpError?.(httpError.finish(!error && complete))
      } catch {
        // Passive diagnostics must not interrupt stream completion or transport cleanup.
        // Do not log the thrown value: diagnostic failures may themselves contain secrets.
      }
      if (observer) options.streamTiming?.(observer.finish(!error && complete))
      if (!error) return
      abort.abort()
      if (gatewayCut) options.warn({ kind: 'stream', status: upstreamResponse.status })
    })
  }
  await send(await options.credential(), false)
}
