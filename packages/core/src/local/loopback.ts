import WebSocket, { type ClientOptions } from 'ws'
import http, { type RequestOptions, type IncomingMessage, type ClientRequest } from 'node:http'
import https from 'node:https'
import { isAbsolute } from 'node:path'

// The one local transport (Node only): child processes and local servers on loopback or a Unix socket, always direct.
// Not the egress: these connections never leave the machine, so no proxy, PAC or system setting applies to them.
import { isLoopbackHost } from '../shared/loopback.ts'

const localAgent = new http.Agent({ keepAlive: true })
const localSecureAgent = new https.Agent({ keepAlive: true })

/** This boundary cannot be used to open an external connection. No DNS lookups are involved in admission. */
function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host.replace(/^\[|\]$/g, '').toLowerCase())) throw new Error('Local transport requires a loopback address or an absolute Unix socket')
}

function assertLocal(address: string | URL): void {
  const value = String(address)
  if (value.startsWith('ws+unix:///')) return
  const url = new URL(value)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('Local transport requires a loopback address or an absolute Unix socket')
  assertLoopbackHost(url.hostname)
}

export function loopbackWebSocket(address: string | URL, options?: ClientOptions): WebSocket {
  assertLocal(address)
  return new WebSocket(address, { ...options, agent: String(address).startsWith('wss:') ? localSecureAgent : localAgent })
}

/** Standalone adapters keep the WHATWG event API on the same explicitly direct local transport. */
export function whatwgLoopbackWebSocket(address: string | URL): globalThis.WebSocket {
  return loopbackWebSocket(address) as unknown as globalThis.WebSocket
}

type HttpAnswer = (response: IncomingMessage) => void
export function loopbackRequest(options: RequestOptions, callback?: HttpAnswer): ClientRequest
export function loopbackRequest(url: string | URL, options?: RequestOptions, callback?: HttpAnswer): ClientRequest
export function loopbackRequest(input: string | URL | RequestOptions, optionsOrCallback?: RequestOptions | HttpAnswer, callback?: HttpAnswer): ClientRequest {
  const url = typeof input === 'string' || input instanceof URL ? new URL(input) : undefined
  const options = url ? typeof optionsOrCallback === 'object' ? optionsOrCallback : {} : input as RequestOptions
  if (options.socketPath) {
    if (!isAbsolute(options.socketPath)) throw new Error('Local transport requires an absolute socket path')
  } else assertLoopbackHost(options.hostname ?? options.host ?? url?.hostname ?? 'localhost')
  const answer = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback
  // An explicit agent keeps NODE_USE_ENV_PROXY or the global agent from sending local traffic through a proxy.
  const protocol = options.protocol ?? url?.protocol ?? 'http:'
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error('Local HTTP transport requires HTTP or HTTPS')
  const transport = protocol === 'https:' ? https : http
  const agent = protocol === 'https:' ? localSecureAgent : localAgent
  return url ? transport.request(url, { ...options, agent }, answer) : transport.request({ ...options, agent }, answer)
}

const BODYLESS = new Set([101, 204, 205, 304])

/** fetch-shaped local request, for code shared across packages (e.g. a harness's local control endpoint). */
export function loopbackFetch(input: string | URL, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = loopbackRequest(new URL(input), { method: init.method ?? 'GET', headers: init.headers, signal: init.signal }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) for (const one of [value ?? []].flat()) headers.append(name, one)
        const status = response.statusCode ?? 0
        resolve(new Response(BODYLESS.has(status) ? null : Buffer.concat(chunks), { status, statusText: response.statusMessage, headers }))
      })
    })
    request.on('error', reject)
    request.end(init.body)
  })
}
