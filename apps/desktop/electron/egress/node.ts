import { Agent, Dispatcher, ProxyAgent, WebSocket as UndiciWebSocket, fetch as undiciFetch } from 'undici'
import { EgressError, causeCode, type EgressBackend, type EgressErrorKind } from '@gugu/core/shared/egress'
import { ProxyRouteError, type ProxyRoute, type RoutesFor } from './proxy-route'
export { installSystemCertificates } from './certificates'

export interface NodeBackendOptions {
  name: string
  routes: RoutesFor
  keepAliveTimeoutMs?: number
  log?: EgressBackend['log']
  ca?: string[]
}

const NODE_ERRNO: Record<string, EgressErrorKind> = {
  ENOTFOUND: 'connect', EAI_AGAIN: 'connect', EAI_NONAME: 'connect',
  ECONNREFUSED: 'connect', EHOSTUNREACH: 'connect', ENETUNREACH: 'connect', EHOSTDOWN: 'connect', ENETDOWN: 'connect',
  ECONNRESET: 'connect', EPIPE: 'connect', ECONNABORTED: 'connect', UND_ERR_SOCKET: 'connect', UND_ERR_CLOSED: 'connect',
  ETIMEDOUT: 'timeout', UND_ERR_CONNECT_TIMEOUT: 'timeout', UND_ERR_HEADERS_TIMEOUT: 'timeout',
}

/** Through a proxy the origin's name is never looked up here: a failure to connect at all is the proxy's. */
const PROXY_UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])

class ProxyFault extends Error {
  constructor(cause: unknown) { super('egress: proxy unreachable', { cause }) }
}

export function classifyNodeError(error: unknown): EgressErrorKind | null {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) {
    if (at instanceof ProxyRouteError || at instanceof ProxyFault) return 'proxy'
    if (at instanceof EgressError) return at.kind
    if (at instanceof AggregateError) {
      const kinds = at.errors.map(classifyNodeError)
      if (kinds.length && kinds.every(kind => kind !== null)) return kinds[0]!
    }
    const status = /Proxy response \((\d{3})/.exec(at.message)?.[1]
    if (status) return status === '407' ? 'proxy-auth' : 'proxy'
    const code = String((at as NodeJS.ErrnoException).code ?? '')
    if (code.startsWith('UND_ERR_SOCKS5_AUTH')) return 'proxy-auth'
    if (code.startsWith('UND_ERR_SOCKS5')) return 'proxy'
    if (NODE_ERRNO[code]) return NODE_ERRNO[code]
    if (code.startsWith('HPE_')) return 'connect'
    if (/^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_|ERR_SSL_)/.test(code)) return 'tls'
  }
  return null
}

/**
 * @@@route-dispatcher - resolves the route when a request is dispatched, then hands it to that route's dispatcher, the
 * structure of @vscode/proxy-agent's ProxyDispatcher. A WebSocket constructor is synchronous; this is how it still gets
 * the system proxy.
 */
class RouteDispatcher extends Dispatcher {
  constructor(private readonly routes: RoutesFor, private readonly via: (route: ProxyRoute) => Dispatcher) { super() }
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    this.routes(String(options.origin)).then(
      route => this.via(route).dispatch(options, handler),
      (error: Error) => handler.onResponseError?.(null as unknown as Dispatcher.DispatchController, error),
    )
    return true
  }
  override close(): Promise<void> { return Promise.resolve() }
  override destroy(): Promise<void> { return Promise.resolve() }
}

/** Every host's one transport; routes come from the environment, or on desktop from Chromium's per-URL resolver. */
export function nodeEgressBackend(options: NodeBackendOptions): EgressBackend & { closeConnections(): Promise<void> } {
  // The egress owns the header deadline; undici bounds only the connection (proxy, SOCKS handshake and TLS included).
  const tls = options.ca ? { ca: options.ca } : {}
  // HTTP/1.1 only: undici 8 offers h2 by default and then puts every request to an origin on one connection, so a file read
  // as three ranged GETs at once shared one connection to the store (one tunnel through a proxy) and ran at its speed.
  const pool = { keepAliveTimeout: options.keepAliveTimeoutMs ?? 60_000, keepAliveMaxTimeout: 600_000, headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10_000, allowH2: false }
  const dispatchers = new Map<string, Dispatcher>()
  const via = (route: ProxyRoute): Dispatcher => {
    const key = route ?? 'direct'
    let dispatcher = dispatchers.get(key)
    if (!dispatcher) {
      dispatcher = route
        // Tunnel plain HTTP too: undici would otherwise send it in absolute form, and WebSocket upgrades need a tunnel.
        // proxyTls makes undici speak TLS to the proxy itself, SOCKS included: only an https:// proxy gets it.
        ? new ProxyAgent({ uri: route, proxyTunnel: true, ...pool, requestTls: tls, ...(route.startsWith('https:') ? { proxyTls: tls } : {}) })
        : new Agent({ ...pool, connect: { timeout: pool.connectTimeout, ...tls } })
      dispatchers.set(key, dispatcher)
    }
    return dispatcher
  }
  const routed = new RouteDispatcher(options.routes, via)
  return {
    name: options.name,
    classify: classifyNodeError,
    log: options.log,
    async closeConnections() {
      const active = [...dispatchers.values()]
      dispatchers.clear()
      await Promise.all(active.map(dispatcher => dispatcher.destroy()))
    },
    async fetch(input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      // Normalize Request inputs once; the bundled undici cannot consume the runtime's own Request class.
      const request = new Request(input, { ...init, duplex: 'half' } as RequestInit)
      const hasBody = request.body !== null
      const route = await options.routes(url)
      init.signal?.throwIfAborted()
      try {
        const response = await undiciFetch(url, {
          method: request.method, headers: Object.fromEntries(request.headers),
          body: hasBody ? (init.body ?? request.body) as never : undefined,
          redirect: request.redirect, credentials: request.credentials,
          signal: init.signal, dispatcher: via(route), ...(hasBody ? { duplex: 'half' as const } : {}),
        })
        return response as unknown as Response
      } catch (error) {
        if (route && !init.signal?.aborted && PROXY_UNREACHABLE.has(causeCode(error) ?? '')) throw new ProxyFault(error)
        throw error
      }
    },
    webSocket(url, { protocols, headers }) {
      return new UndiciWebSocket(url, { protocols, headers, dispatcher: routed }) as unknown as globalThis.WebSocket
    },
  }
}
