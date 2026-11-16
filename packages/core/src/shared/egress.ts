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

export type EgressErrorKind = 'dns' | 'connect' | 'proxy' | 'proxy-auth' | 'tls' | 'timeout' | 'reset'

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

export interface EgressFetchInit extends RequestInit {
  /** Deadline until the response headers arrive. Default 30 s; 0 = none (long polls). The body has no deadline. */
  timeoutMs?: number
}

export interface EgressWebSocketOptions {
  protocols?: string | string[]
  headers?: Record<string, string>
  /** Deadline for the whole opening handshake, proxy lookup and tunnel included. Default 10 s. */
  handshakeTimeoutMs?: number
}

export interface Egress {
  fetch(input: string | URL | Request, init?: EgressFetchInit): Promise<Response>
  /** WHATWG shape (addEventListener / onopen / send / close). */
  webSocket(url: string | URL, options?: EgressWebSocketOptions): WebSocket
}

/** What a backend provides: its runtime's primitives, and how its errors map to a kind (null = not a network failure). */
export interface EgressBackend {
  name: string
  fetch(input: string | URL | Request, init: RequestInit): Promise<Response>
  webSocket(url: string, options: { protocols?: string | string[]; headers?: Record<string, string> }): WebSocket
  classify(error: unknown): EgressErrorKind | null
  /** One line per failure: kind, host, route. Never credentials. */
  log?(event: { kind: EgressErrorKind; host: string; backend: string; cause: unknown }): void
}

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

function hostOf(input: string | URL | Request): string {
  try {
    return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host
  } catch {
    return ''
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function createEgress(backend: EgressBackend): Egress {
  const fail = (kind: EgressErrorKind, host: string, cause: unknown): EgressError => {
    backend.log?.({ kind, host, backend: backend.name, cause })
    return new EgressError(kind, host, cause)
  }
  return {
    async fetch(input, init = {}) {
      const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...rest } = init
      const host = hostOf(input)
      const deadline = new AbortController()
      const caller = rest.signal
      const onCallerAbort = () => deadline.abort(caller?.reason)
      if (caller?.aborted) deadline.abort(caller.reason)
      else caller?.addEventListener('abort', onCallerAbort, { once: true })
      let timedOut = false
      const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; deadline.abort() }, timeoutMs) : undefined
      try {
        const response = await backend.fetch(input, { ...rest, signal: deadline.signal })
        // A proxy that wants credentials answers 407 itself; no origin server does. First version: say so clearly.
        if (response.status === 407) {
          void response.body?.cancel().catch(() => {})
          throw fail('proxy-auth', host, new Error('407 Proxy Authentication Required'))
        }
        return response
      } catch (error) {
        if (error instanceof EgressError) throw error
        if (timedOut) throw fail('timeout', host, error)
        if (caller?.aborted || isAbort(error)) throw error
        const kind = backend.classify(error)
        if (kind) throw fail(kind, host, error)
        throw error
      } finally {
        clearTimeout(timer)
        caller?.removeEventListener('abort', onCallerAbort)
      }
    },

    webSocket(url, options = {}) {
      const href = typeof url === 'string' ? url : url.href
      const host = hostOf(href)
      const socket = backend.webSocket(href, { protocols: options.protocols, headers: options.headers })
      const limit = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
      // A path that accepts the connection and never answers (a dead tunnel, a silent proxy) must not leave the
      // socket CONNECTING for good: Realtime skips connect() while connecting, so every channel join would time out.
      const timer = limit > 0
        ? setTimeout(() => {
          if (socket.readyState !== socket.CONNECTING) return
          backend.log?.({ kind: 'timeout', host, backend: backend.name, cause: new Error('opening handshake timed out') })
          socket.close()
        }, limit)
        : undefined
      socket.addEventListener('open', () => clearTimeout(timer), { once: true })
      socket.addEventListener('close', (event) => {
        clearTimeout(timer)
        if (event.code === 1006 && event.reason) {
          const kind = backend.classify(new Error(event.reason))
          if (kind) backend.log?.({ kind, host, backend: backend.name, cause: event.reason })
        }
      }, { once: true })
      return socket
    },
  }
}

let installed: Egress | null = null

export function installEgress(impl: Egress): void {
  installed = impl
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

/** The runtime's own fetch and WebSocket, for the renderer and mobile (and tests): proxy and certificates are the runtime's. */
export function runtimeEgress(): Egress {
  return createEgress({
    name: 'runtime',
    // eslint-disable-next-line no-restricted-properties -- the runtime backend is the one place that reads the global fetch
    fetch: (input, init) => globalThis.fetch(input, init),
    // eslint-disable-next-line no-restricted-properties -- same for the runtime's WebSocket
    webSocket: (url, { protocols }) => new globalThis.WebSocket(url, protocols),
    classify: (error) => (error instanceof TypeError ? 'connect' : null),
  })
}

/** The one sentence a person or an agent reads when a request got no answer: what is wrong, in their terms, and what to do. */
export function egressErrorText(kind: EgressErrorKind): string {
  switch (kind) {
    case 'proxy-auth': return '咕咕经过的代理要求登录认证，这次请求被代理拒绝了。请在代理软件里关掉认证，或换一个不需要认证的代理后再试。'
    case 'tls': return '咕咕连上了服务器，但证书校验没通过（常见于会解密 HTTPS 的代理或安全软件）。请把它的根证书装进系统信任库，或关掉 HTTPS 解密后再试。'
    case 'proxy': return '咕咕连不上配置的代理（代理没开、地址不对或拒绝了连接）。请检查代理软件和系统代理设置后再试。'
    default: return '咕咕连不上服务器（网络或代理有问题），这次调用没有得到回答。请检查网络或代理设置后再试。'
  }
}
