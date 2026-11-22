/**
 * Egress: the one way a host process reaches the network (every HTTP request and every WebSocket to the outside).
 *
 * It decides which proxy, which certificates, how long to wait and how a failure reads; product code only says what
 * it wants. A backend (`apps/desktop/electron/egress/*`) supplies the raw primitives for its process and how to tell
 * its runtime's errors apart; this module adds the parts that must not depend on the backend: the header deadline,
 * the handshake deadline, and one error type.
 *
 * Not egress: loopback / unix-socket traffic to local child processes, local servers, SSH, and the network of child
 * processes (they get their environment, see agent-env). HTTP statuses are answers, not egress errors — except a 407
 * from a proxy, which is the proxy refusing us.
 *
 * In a host process, nothing installed means a bug (a call before the host set up its network), so it throws rather than
 * quietly using whatever the runtime has. Browser runtimes (renderer, App pages, mobile) use the runtime's own.
 */

import { anySignal } from './anySignal'
import { runtimeEgress } from './egress/runtime'
import { networkResponse } from './egress/response'
export { runtimeEgress } from './egress/runtime'

/** `connect`: no usable connection to the target (name lookup, refusal, reset). The rest name who to look at. */
export type EgressErrorKind = 'connect' | 'proxy' | 'proxy-auth' | 'tls' | 'timeout'

/** The request got no answer. `host` is the target host only (no path, no query); `cause` goes to logs, not to people. */
export class EgressError extends Error {
  readonly kind: EgressErrorKind
  readonly host: string

  constructor(kind: EgressErrorKind, host: string, cause?: unknown) {
    super(`egress ${kind}: ${host}`, { cause })
    this.name = 'EgressError'
    this.kind = kind
    this.host = host
  }
}

/** The first Node/undici error code on the cause chain (and inside aggregates), for callers that report finer reasons. */
export function causeCode(error: unknown): string | undefined {
  const pending: unknown[] = [error]
  for (let count = 0; pending.length && count < 32; count++) {
    const at = pending.shift()
    if (!at || typeof at !== 'object') continue
    const code: unknown = Reflect.get(at, 'code')
    if (typeof code === 'string') return code
    pending.push(Reflect.get(at, 'cause'))
    const errors: unknown = Reflect.get(at, 'errors')
    if (Array.isArray(errors)) pending.push(...errors.slice(0, 32))
  }
  return undefined
}

export interface EgressFetchInit extends RequestInit {
  /** Deadline until the response headers arrive. Default 30 s; 0 = none (long polls). The body has no deadline. */
  timeoutMs?: number
}

export type EgressEnvironment = Readonly<Record<string, string | undefined>>
export type EnvironmentFetch = (env: EgressEnvironment, input: string | URL | Request, init?: EgressFetchInit) => Promise<Response>

export interface EgressWebSocketOptions {
  protocols?: string | string[]
  headers?: Record<string, string>
  /** Deadline for the whole opening handshake, proxy lookup and tunnel included. Default 10 s. */
  handshakeTimeoutMs?: number
}

export interface Egress {
  fetch(input: string | URL | Request, init?: EgressFetchInit): Promise<Response>
  /** WHATWG shape (addEventListener / onopen / send / close). */
  webSocket(url: string | URL, options?: EgressWebSocketOptions): globalThis.WebSocket
}

/** What a backend provides: its runtime's primitives, and how its errors map to a kind (null = not a network failure). */
export interface EgressBackend {
  name: string
  fetch(input: string | URL | Request, init: RequestInit): Promise<Response>
  webSocket(url: string, options: { protocols?: string | string[]; headers?: Record<string, string> }): globalThis.WebSocket
  classify(error: unknown): EgressErrorKind | null
  /** One line per failure: kind, host, route. Never credentials. */
  log?(event: { kind: EgressErrorKind; host: string; backend: string; cause: unknown }): void
}

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

export function egressHost(input: string | URL | Request): string {
  try {
    return new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href).host
  } catch {
    return ''
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function createEgress(backend: EgressBackend): Egress {
  const report = (error: EgressError): EgressError => {
    if (error.kind === 'proxy' || error.kind === 'proxy-auth') error.message = egressErrorText(error.kind)
    backend.log?.({ kind: error.kind, host: error.host, backend: backend.name, cause: error.cause })
    return error
  }
  return {
    async fetch(input, init = {}) {
      const scheme = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href).protocol
      if (scheme !== 'http:' && scheme !== 'https:') throw new TypeError('Egress fetch requires an HTTP or HTTPS URL')
      const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...rest } = init
      const host = egressHost(input)
      const deadline = new AbortController()
      const caller = rest.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined)
      const signal = anySignal([caller, deadline.signal])
      let onAbort: (() => void) | undefined
      let timedOut = false
      const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; deadline.abort() }, timeoutMs) : undefined
      try {
        signal.throwIfAborted()
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
        })
        const response = await Promise.race([backend.fetch(input, { ...rest, signal }), aborted])
        // A proxy that wants credentials answers 407 itself; no origin server does. The egress does not authenticate.
        if (response.status === 407) {
          void response.body?.cancel().catch(() => {})
          throw new EgressError('proxy-auth', host, new Error('407 Proxy Authentication Required'))
        }
        return networkResponse(response, error => {
          if (signal.aborted) return signal.reason
          const kind = backend.classify(error)
          return kind ? report(new EgressError(kind, host, error)) : error
        })
      } catch (error) {
        if (error instanceof EgressError) throw report(error)
        if (timedOut) throw report(new EgressError('timeout', host, error))
        if (caller?.aborted || isAbort(error)) throw error
        const kind = backend.classify(error)
        if (kind) throw report(new EgressError(kind, host, error))
        throw error
      } finally {
        clearTimeout(timer)
        if (onAbort) signal.removeEventListener('abort', onAbort)
      }
    },

    webSocket(url, options = {}) {
      const scheme = new URL(String(url)).protocol
      if (scheme !== 'ws:' && scheme !== 'wss:') throw new TypeError('Egress WebSocket requires a WS or WSS URL')
      const host = egressHost(url)
      const socket = backend.webSocket(String(url), { protocols: options.protocols, headers: options.headers })
      socket.binaryType = 'arraybuffer'
      // A socket still opening when the deadline passes is failed (error, then close), like any WHATWG socket.
      const limit = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
      let timedOut = false
      const timer = limit > 0 ? setTimeout(() => { timedOut = true; socket.close() }, limit) : undefined
      socket.addEventListener('open', () => clearTimeout(timer), { once: true })
      socket.addEventListener('close', () => clearTimeout(timer), { once: true })
      socket.addEventListener('error', () => { report(new EgressError(timedOut ? 'timeout' : 'connect', host)) })
      return socket
    },
  }
}

let installed: Egress | null = null
let environmentFetch: EnvironmentFetch | undefined

export function installEgress(impl: Egress): void {
  installed = impl
}

/** Requests on behalf of a harness, in that harness's environment. Workers install only this. */
export function installEnvironmentFetch(impl: EnvironmentFetch): void {
  environmentFetch = impl
}

/** Requests made with a harness's credentials follow that harness's supplied environment on every host. */
export function fetchWithEnv(env: EgressEnvironment, input: string | URL | Request, init?: EgressFetchInit): Promise<Response> {
  if (!environmentFetch) throw new Error('egress: environment transport is not installed')
  return environmentFetch(env, input, init)
}

/**
 * A browser runtime (renderer pages, App pages, mobile) has one network stack and it is already the right one, so its
 * egress is the runtime's own unless something was installed. A host process has no `document`: there an uninstalled
 * egress is a bug and throws.
 */
function current(): Egress {
  if (installed) return installed
  if (typeof document !== 'undefined') return (installed = runtimeEgress())
  throw new Error('egress: no backend installed (a network call before the host set up its network)')
}

export const egress: Egress = {
  fetch: (input, init) => current().fetch(input, init),
  webSocket: (url, options) => current().webSocket(url, options),
}

/** The one sentence a person or an agent reads when a request got no answer: what is wrong, in their terms, and what to do. */
export function egressErrorText(kind: EgressErrorKind): string {
  switch (kind) {
    case 'proxy-auth': return '代理要求登录，咕咕暂不支持需要认证的代理。请换一个不需要认证的代理，或在代理软件里放行咕咕后再试。'
    case 'tls': return '咕咕连上了服务器，但证书校验没通过（常见于会解密 HTTPS 的代理或安全软件）。请把它的根证书装进系统信任库，或关掉 HTTPS 解密后再试。'
    case 'proxy': return '咕咕连不上配置的代理。请检查代理软件和系统代理设置后再试。'
    default: return '咕咕连不上服务器（网络或代理有问题），这次调用没有得到回答。请检查网络或代理设置后再试。'
  }
}
