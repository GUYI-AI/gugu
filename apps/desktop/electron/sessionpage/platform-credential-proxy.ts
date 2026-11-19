import { request as httpRequest, type IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { finished, pipeline } from 'node:stream'
import { PlatformStreamTimingRecorder, type PlatformStreamTiming } from './platform-stream-timing'
import { PlatformHttpErrorRecorder, type PlatformHttpErrorDiagnostic } from './platform-http-error'

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

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
  warn: (event: { kind: 'connection' | 'stream'; status?: number; code?: string }) => void
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

function upstreamHeaders(headers: IncomingHttpHeaders, options: CredentialProxyOptions, token: string, upstream: URL) {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (value === undefined || HOP_HEADERS.has(key) || options.localOnlyHeaders.has(key)) continue
    // A Claude helper value can appear in BOTH headers. Neither local credential may escape.
    if (key === 'authorization' || key === 'x-api-key') continue
    result[name] = value
  }
  result.host = upstream.host
  if (options.credentialHeaders) Object.assign(result, options.credentialHeaders(token))
  else {
    result.authorization = `Bearer ${token}`
    if (headers['x-api-key'] !== undefined) result['x-api-key'] = token
  }
  return result
}

/** Replay only an unaccepted 401, once. Request bytes are retained; response SSE is never buffered. */
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
  let upstreamRequest: ReturnType<typeof httpRequest> | undefined
  let harnessGone = response.destroyed
  let gatewayCut = false
  finished(response, (error) => {
    if (!error) return
    if (!gatewayCut) harnessGone = true
    upstreamRequest?.destroy()
  })
  const send = (token: string, retried: boolean): void => {
    if (harnessGone) return
    const upstream = options.upstream()
    const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest
    const startedAt = performance.now()
    const wallStart = Date.now()
    upstreamRequest = transport(upstream, {
      method: request.method,
      headers: upstreamHeaders(request.headers, options, token, upstream),
    }, (upstreamResponse) => {
      const forward = async () => {
        const status = upstreamResponse.statusCode ?? 502
        if (options.refusal && (status === 401 || status === 403)) {
          const refusal = await options.refusal(status, retried)
          if (refusal) {
            upstreamResponse.resume()
            if (!harnessGone && !response.headersSent) {
              response.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              response.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', ...refusal } }))
            }
            return
          }
        }
        if ((status === 401 || (status === 403 && options.refreshForbidden)) && !retried && options.refresh) {
          // No inference was accepted and no response headers/bytes have reached the harness.
          upstreamResponse.resume()
          void options.refresh(token).then(next => send(next, true), error => {
            if (!response.headersSent && !harnessGone) {
              const refusal = options.refusalError?.(error)
              if (refusal) {
                response.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                response.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', ...refusal } }))
                return
              }
              response.writeHead(503, { 'content-type': 'application/json' })
              response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Platform credential refresh failed' } }))
            }
          })
          return
        }
        const headers: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (value !== undefined && !HOP_HEADERS.has(name.toLowerCase())) headers[name] = value
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, headers)
        const isSse = /^text\/event-stream\b/i.test(String(upstreamResponse.headers['content-type'] ?? ''))
        const compressed = !['', 'identity'].includes(String(upstreamResponse.headers['content-encoding'] ?? '').toLowerCase())
        const httpError = upstreamResponse.statusCode === 400 && options.httpError
          ? new PlatformHttpErrorRecorder(upstreamResponse.headers) : undefined
        if (httpError) upstreamResponse.on('data', (chunk: Buffer) => httpError.data(chunk))
        // Encoded bytes remain observable; do not pretend compressed bytes are parsed SSE events.
        const observer = isSse && options.streamTiming
          ? new PlatformStreamTimingRecorder(!compressed, () => performance.now(), wallStart, startedAt)
          : undefined
        if (observer) upstreamResponse.on('data', (chunk: Buffer) => observer.data(chunk))
        upstreamResponse.once('close', () => {
          if (!upstreamResponse.complete && !harnessGone) gatewayCut = true
        })
        pipeline(upstreamResponse, response, (error) => {
          try {
            if (httpError) options.httpError?.(httpError.finish(!error && upstreamResponse.complete))
          } catch {
            // Passive diagnostics must not interrupt stream completion or transport cleanup.
            // Do not log the thrown value: diagnostic failures may themselves contain secrets.
          }
          if (observer) options.streamTiming?.(observer.finish(!error && upstreamResponse.complete))
          if (!error) return
          upstreamRequest?.destroy()
          if (gatewayCut) options.warn({ kind: 'stream', status: upstreamResponse.statusCode })
        })
      }
      void forward().catch(() => {
        upstreamResponse.resume()
        if (!response.headersSent && !harnessGone) response.writeHead(503).end()
        else response.destroy()
      })
    })
    upstreamRequest.on('error', (error: NodeJS.ErrnoException) => {
      if (!harnessGone) options.warn({ kind: 'connection', code: error.code })
      if (!response.headersSent) response.writeHead(502).end()
      else response.destroy()
    })
    upstreamRequest.end(body)
  }
  send(await options.credential(), false)
}
