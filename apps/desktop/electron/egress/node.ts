/**
 * Node egress backend: undici for HTTP, `ws` for WebSocket, both routed by a `RoutesFor` (Chromium's answer on the
 * desktop, the environment on a headless host or server).
 *
 * - Routes are tried in order; the next one only when this one could not connect (a dead proxy in `PROXY a; PROXY b;
 *   DIRECT`). A request body is sent once per attempt, so only buffered bodies are retried.
 * - HTTP/HTTPS proxies: CONNECT. SOCKS is not supported here and fails as `proxy`, never as a silent direct connection.
 * - Certificates: `installSystemCertificates` puts the OS store next to Node's bundled roots, once per process; undici,
 *   ws and https all read the default set.
 * - Idle connections: undici closes them after 4 s by default, which re-pays a TLS handshake between two bursts
 *   (#5331). The keep-alive is a parameter so it can be measured both ways.
 */
import net from 'node:net'
import tls from 'node:tls'
import type { Duplex } from 'node:stream'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import WebSocket from 'ws'
import type { EgressBackend, EgressErrorKind } from '@gugu/core/shared/egress'
import type { ProxyRoute, RoutesFor } from './proxy-route'

export interface NodeBackendOptions {
  name: string
  routes: RoutesFor
  /** Idle keep-alive for pooled connections; undici's default is 4 s. */
  keepAliveTimeoutMs?: number
  log?: EgressBackend['log']
}

const NODE_ERRNO: Record<string, EgressErrorKind> = {
  ENOTFOUND: 'dns', EAI_AGAIN: 'dns', EAI_NONAME: 'dns',
  ECONNREFUSED: 'connect', EHOSTUNREACH: 'connect', ENETUNREACH: 'connect', EHOSTDOWN: 'connect', ENETDOWN: 'connect',
  ECONNRESET: 'reset', EPIPE: 'reset', ECONNABORTED: 'reset', UND_ERR_SOCKET: 'reset', UND_ERR_CLOSED: 'reset',
  ETIMEDOUT: 'timeout', UND_ERR_CONNECT_TIMEOUT: 'timeout', UND_ERR_HEADERS_TIMEOUT: 'timeout',
}

/** A proxy-stage failure, raised by the tunnel and by undici's ProxyAgent ("Proxy response (407) !== 200 when HTTP Tunneling"). */
class ProxyStageError extends Error {
  constructor(readonly status: number | null, message: string) { super(message); this.name = 'ProxyStageError' }
}

export function classifyNodeError(error: unknown): EgressErrorKind | null {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 6; at = at.cause, depth++) {
    if (at instanceof ProxyStageError) return at.status === 407 ? 'proxy-auth' : 'proxy'
    const proxyStatus = /Proxy response \((\d{3})\)/.exec(at.message)?.[1]
    if (proxyStatus) return proxyStatus === '407' ? 'proxy-auth' : 'proxy'
    const code = (at as NodeJS.ErrnoException).code
    if (typeof code === 'string') {
      if (NODE_ERRNO[code]) return NODE_ERRNO[code]
      if (/^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH)/.test(code)) return 'tls'
    }
  }
  return null
}

/** Once per process: the OS trust store next to Node's bundled roots (Node 24.5+ API; the packaged app ignores NODE_OPTIONS). */
export function installSystemCertificates(): void {
  const api = tls as typeof tls & { getCACertificates?: (kind: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void }
  if (!api.getCACertificates || !api.setDefaultCACertificates) throw new Error('egress: this Node has no system certificate API')
  api.setDefaultCACertificates([...new Set([...api.getCACertificates('bundled'), ...api.getCACertificates('system')])])
}

/** CONNECT through an HTTP(S) proxy; resolves with the raw tunnel socket. The caller bounds it (`settle` on deadline). */
function openTunnel(route: Extract<ProxyRoute, { kind: 'http' | 'https' }>, host: string, port: number, onSocket: (s: net.Socket) => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket: net.Socket = route.kind === 'https'
      ? tls.connect({ host: route.host, port: route.port, servername: net.isIP(route.host) ? undefined : route.host })
      : net.connect({ host: route.host, port: route.port })
    onSocket(socket)
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`
    let head = Buffer.alloc(0)
    const onError = (error: Error) => reject(error)
    const onClose = () => reject(new ProxyStageError(null, `proxy ${route.host}:${route.port} closed before the tunnel opened`))
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData).off('error', onError).off('close', onClose)
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'))?.[1] ?? 0)
      // Nothing follows the proxy's answer: the server speaks only after our TLS hello or upgrade request.
      if (status === 200) resolve(socket)
      else { socket.destroy(); reject(new ProxyStageError(status, `proxy ${route.host}:${route.port} refused the tunnel (${status || 'no status'})`)) }
    }
    socket.once('error', onError).once('close', onClose).on('data', onData)
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
  })
}

type ConnectOptions = tls.ConnectionOptions & { host?: string | null; port?: number | string | null; timeout?: number }

/**
 * `ws`'s `createConnection` (callback form): asks the routes, connects direct exactly as ws would, or tunnels.
 * ws's own handshake timeout starts only once Node has a socket, so `options.timeout` bounds the lookup and the tunnel.
 */
function routedConnection(routes: RoutesFor, secure: boolean) {
  return (options: ConnectOptions, done: (error: Error | null, socket?: Duplex) => void): undefined => {
    const host = String(options.host ?? 'localhost')
    const port = Number(options.port)
    let pending: net.Socket | undefined
    let settled = false
    const settle = (error: Error | null, socket?: Duplex) => {
      if (settled) { socket?.destroy(); return }
      settled = true
      clearTimeout(timer)
      if (error) pending?.destroy()
      done(error, socket)
    }
    const timer = options.timeout ? setTimeout(() => settle(new ProxyStageError(null, 'opening handshake timed out')), options.timeout) : undefined
    const finish = (raw?: net.Socket): Duplex => {
      if (!secure) return raw ?? net.connect({ ...options, host, port } as net.NetConnectOpts)
      const servername = options.servername || options.servername === '' ? options.servername : net.isIP(host) ? '' : host
      return tls.connect({ ...options, host, port, servername, ...(raw ? { socket: raw } : {}) })
    }
    void (async () => {
      let last: unknown = null
      for (const route of await routes(`${secure ? 'https' : 'http'}://${host}:${port}/`)) {
        if (settled) return
        if (route.kind === 'direct') return settle(null, finish())
        if (route.kind === 'socks4' || route.kind === 'socks5') { last = new ProxyStageError(null, `${route.kind} proxy is not supported`); continue }
        try { return settle(null, finish(await openTunnel(route, host, port, (s) => { pending = s }))) } catch (error) { last = error }
      }
      settle(last instanceof Error ? last : new ProxyStageError(null, 'no usable proxy route'))
    })().catch((error: unknown) => settle(error instanceof Error ? error : new Error(String(error))))
    return undefined
  }
}

export function nodeEgressBackend(options: NodeBackendOptions): EgressBackend {
  const { routes, keepAliveTimeoutMs } = options
  const pool = keepAliveTimeoutMs === undefined ? {} : { keepAliveTimeout: keepAliveTimeoutMs, keepAliveMaxTimeout: Math.max(keepAliveTimeoutMs, 600_000) }
  const dispatchers = new Map<string, Dispatcher>()
  const dispatcherFor = (route: ProxyRoute): Dispatcher => {
    const key = route.kind === 'direct' ? 'direct' : `${route.kind}://${route.host}:${route.port}`
    let found = dispatchers.get(key)
    if (!found) {
      if (route.kind === 'socks4' || route.kind === 'socks5') throw new ProxyStageError(null, `${route.kind} proxy is not supported`)
      found = route.kind === 'direct' ? new Agent(pool) : new ProxyAgent({ uri: `${route.kind}://${route.host}:${route.port}`, ...pool })
      dispatchers.set(key, found)
    }
    return found
  }
  return {
    name: options.name,
    classify: classifyNodeError,
    log: options.log,
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const request = typeof input === 'string' || input instanceof URL ? init : { method: input.method, headers: input.headers, body: input.body, ...init }
      const replayable = request.body == null || typeof request.body === 'string' || request.body instanceof Uint8Array || request.body instanceof URLSearchParams
      const list = await routes(url)
      let last: unknown = null
      for (const [index, route] of list.entries()) {
        try {
          const dispatcher = dispatcherFor(route)
          return await undiciFetch(url, { ...(request as object), dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Response
        } catch (error) {
          last = error
          const kind = classifyNodeError(error)
          const next = index < list.length - 1 && replayable && !init.signal?.aborted && (kind === 'proxy' || kind === 'connect' || kind === 'dns')
          if (!next) throw error
        }
      }
      throw last
    },
    webSocket(url, { protocols, headers }) {
      const secure = /^(wss|https):/.test(url)
      const socket = new WebSocket(url, protocols, {
        headers,
        // Same deadline as the egress wrapper, so a half-open tunnel cleans itself up as well.
        handshakeTimeout: 10_000,
        createConnection: routedConnection(routes, secure) as never,
      })
      return socket as unknown as globalThis.WebSocket
    },
  }
}
