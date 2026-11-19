import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import type { ClientRequest } from 'node:http'
import { Agent as SocketAgent, type AgentConnectOpts } from 'agent-base'
import { Agent, Pool, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import WebSocket from 'ws'
import { EgressError, type EgressBackend, type EgressErrorKind } from '@gugu/core/shared/egress'
import { ProxyRouteError, proxyEndpoints, type ProxyRoute, type RoutesFor } from './proxy-route'
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

class RouteError extends Error {
  readonly route: ProxyRoute['kind']
  readonly proxies: string[]
  constructor(readonly kind: EgressErrorKind, route: ProxyRoute, cause: unknown, readonly beforeRequest = false) {
    super(`egress route failed (${route.kind})`, { cause })
    this.route = route.kind
    this.proxies = proxyEndpoints([route])
  }
}

export function classifyNodeError(error: unknown): EgressErrorKind | null {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) {
    if (at instanceof ProxyRouteError) return 'proxy'
    if (at instanceof RouteError || at instanceof EgressError) return at.kind
    if (at instanceof AggregateError) {
      const kinds = at.errors.map(classifyNodeError)
      if (kinds.length && kinds.every(kind => kind !== null)) return kinds[0]!
    }
    if (/socks5 authentication failed|no accepted auth type/i.test(at.message)) return 'proxy-auth'
    const status = /Proxy response \((\d{3})/.exec(at.message)?.[1]
    if (status) return status === '407' ? 'proxy-auth' : 'proxy'
    if (/Unexpected server response: \d{3}/.test(at.message)) return 'connect'
    const code = (at as NodeJS.ErrnoException).code
    if (code && NODE_ERRNO[code]) return NODE_ERRNO[code]
    if (typeof code === 'string' && code.startsWith('HPE_')) return 'connect'
    if (code && /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_|ERR_SSL_)/.test(code)) return 'tls'
  }
  return null
}

/** Through a proxy, a connection that never got established is the proxy's failure; a later one is not. */
function routeFailure(route: ProxyRoute, error: unknown): RouteError {
  const kind = classifyNodeError(error)
  if (!kind) throw error
  const proxyFault = route.kind !== 'direct' && kind === 'connect' && connectionFailedBeforeRequest(error, true)
  return new RouteError(proxyFault ? 'proxy' : kind, route, error)
}

/** These facts precede origin request bytes. A generic/reset/header failure may follow a committed POST. */
function connectionFailedBeforeRequest(error: unknown, proxyConnect = false): boolean {
  for (let at = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth++) {
    if (at instanceof RouteError && at.beforeRequest) return at.kind !== 'tls' && at.kind !== 'proxy-auth'
    if (at instanceof AggregateError && at.errors.length) return at.errors.every(error => connectionFailedBeforeRequest(error, proxyConnect))
    if ((at as NodeJS.ErrnoException).code === 'ETIMEDOUT' && (at as NodeJS.ErrnoException).syscall === 'connect') return true
    if (proxyConnect && (at as NodeJS.ErrnoException).code === 'UND_ERR_HEADERS_TIMEOUT') return true
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes((at as NodeJS.ErrnoException).code ?? '')) return true
    if (/Proxy response \((?!407)\d{3}/.test(at.message)) return true
  }
  return false
}

function proxyUrl(route: Exclude<ProxyRoute, { kind: 'direct' }>): string {
  const scheme = route.kind === 'socks5' ? 'socks5h' : route.kind === 'socks4' ? 'socks4a' : route.kind
  const url = new URL(`${scheme}://${route.host.includes(':') ? `[${route.host}]` : route.host}:${route.port}`)
  url.username = route.username ?? ''
  url.password = route.password ?? ''
  return url.href
}

/** Proxy agents remove the TCP host when wrapping a tunnel; retain the origin identity, including IP SANs. */
function originTls(host: string, ca?: string[]): tls.ConnectionOptions {
  return { ca, checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(host, certificate) }
}

/** Every host's one transport; routes come from the environment, or on desktop from Chromium's per-URL resolver. */
export function nodeEgressBackend(options: NodeBackendOptions): EgressBackend & { closeConnections(): Promise<void> } {
  const keepAliveTimeout = options.keepAliveTimeoutMs ?? 60_000
  // Each route gets a bounded connection attempt; the public header deadline spans the complete fallback list.
  const pool = { keepAliveTimeout, keepAliveMaxTimeout: 600_000, headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000, ...(options.ca ? { ca: options.ca } : {}) } }
  const dispatchers = new Map<string, Dispatcher>()
  const dispatcherFor = (route: ProxyRoute): Dispatcher => {
    const key = route.kind === 'direct' ? 'direct' : proxyUrl(route)
    let dispatcher = dispatchers.get(key)
    if (!dispatcher) {
      if (route.kind === 'direct') dispatcher = new Agent(pool)
      else if (route.kind === 'socks4' || route.kind === 'socks5') {
        // @@@socks-idle - socks-proxy-agent's `timeout` also becomes an idle timeout on the open socket (it destroyed idle
        // keep-alive and Realtime connections every few seconds), so only the connect stage is bounded, per attempt.
        dispatcher = new Agent({ ...pool, connect: (target, callback) => {
          let socket: net.Socket | undefined
          const attempt = new AbortController()
          const deadline = setTimeout(() => attempt.abort(Object.assign(new Error('Connection attempt timed out'), { code: 'ETIMEDOUT', syscall: 'connect' })), 10_000)
          const proxy = new SocksProxyAgent(key, { socketOptions: { signal: attempt.signal } })
          // socks-proxy-agent only uses the request to destroy it on a TLS failure.
          const request = { destroy: () => socket?.destroy() } as unknown as ClientRequest
          // undici hands an empty servername for a plain hostname; passed through, the TLS hello carries no SNI and a CDN
          // answers with its fallback certificate. SNI is the origin hostname (never an IP literal).
          const servername = target.servername || (net.isIP(target.hostname) ? undefined : target.hostname)
          void proxy.connect(request, { host: target.hostname, port: Number(target.port) || (target.protocol === 'https:' ? 443 : 80),
            secureEndpoint: target.protocol === 'https:', servername, ...originTls(servername || target.hostname, options.ca) } as AgentConnectOpts)
            .then(async connected => {
              socket = connected
              if (target.protocol === 'https:') await once(connected, 'secureConnect', { signal: attempt.signal })
              clearTimeout(deadline)
              callback(null, connected)
            }).catch(error => {
              clearTimeout(deadline)
              socket?.destroy()
              const cause = attempt.signal.aborted ? attempt.signal.reason : error
              callback(new RouteError(classifyNodeError(cause) ?? 'proxy', route, cause, true), null)
            })
        } })
      } else dispatcher = new ProxyAgent({ uri: key, ...pool, proxyTls: pool.connect, requestTls: pool.connect,
        // Only CONNECT headers get this bound; origin headers are owned by the outer request deadline.
        clientFactory: (origin, settings) => new Pool(origin, { ...pool, ...settings, headersTimeout: 10_000 }),
      })
      dispatchers.set(key, dispatcher)
    }
    return dispatcher
  }
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
      // Normalize Request inputs once; undici 6 cannot consume the runtime's undici 7 Request class.
      const request = new Request(input, { ...init, duplex: 'half' } as RequestInit)
      const hasBody = request.body !== null
      const body = init.body ?? request.body
      const replayable = body == null || typeof body === 'string' || body instanceof Uint8Array || body instanceof URLSearchParams
      const list = await options.routes(url)
      init.signal?.throwIfAborted()
      for (const [index, route] of list.entries()) {
        try {
          const response = await undiciFetch(url, {
            method: request.method, headers: Object.fromEntries(request.headers),
            body: hasBody ? body as never : undefined,
            redirect: request.redirect, credentials: request.credentials,
            signal: init.signal, dispatcher: dispatcherFor(route), ...(hasBody ? { duplex: 'half' as const } : {}),
          })
          return response as unknown as Response
        } catch (error) {
          if (init.signal?.aborted) throw error
          const failure = routeFailure(route, error)
          if (index + 1 === list.length || !replayable || !connectionFailedBeforeRequest(error, route.kind !== 'direct')) throw failure
        }
      }
      throw new Error('egress: proxy resolver returned no routes')
    },
    webSocket(url, { protocols, headers, signal, onError }) {
      signal.throwIfAborted()
      // @@@socket-before-upgrade - resolve routes at socket creation, so listeners attach before the first WS frame.
      const agent = new class extends SocketAgent {
        async connect(request: ClientRequest, socketOptions: AgentConnectOpts) {
          const originHost = socketOptions.secureEndpoint ? socketOptions.servername || socketOptions.host! : socketOptions.host!
          const list = await options.routes(url)
          signal.throwIfAborted()
          for (const [index, route] of list.entries()) {
            let proxyStatus: number | undefined
            const connected = (response: { statusCode: number }) => { proxyStatus = response.statusCode }
            const attempt = new AbortController()
            const deadline = setTimeout(() => attempt.abort(Object.assign(new Error('Connection attempt timed out'), { code: 'ETIMEDOUT', syscall: 'connect' })), 5_000)
            const cancel = () => attempt.abort(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
            const routeSignal = attempt.signal
            try {
              if (route.kind === 'direct') {
                const socket = socketOptions.secureEndpoint
                  ? tls.connect({ ...socketOptions, path: undefined, signal: routeSignal, ca: options.ca,
                    servername: socketOptions.servername ?? (net.isIP(socketOptions.host ?? '') ? '' : socketOptions.host) } as tls.ConnectionOptions)
                  : net.connect({ ...socketOptions, path: undefined, signal: routeSignal })
                try { await once(socket, socketOptions.secureEndpoint ? 'secureConnect' : 'connect', { signal: routeSignal }) }
                catch (error) { socket.destroy(); throw error }
                return socket
              }
              if (route.kind === 'socks4' || route.kind === 'socks5') {
                // The attempt deadline bounds the connect; no agent `timeout`, which would also kill the idle socket (@@@socks-idle).
                const proxy = new SocksProxyAgent(proxyUrl(route), { socketOptions: { signal: routeSignal } })
                return await proxy.connect(request, { ...socketOptions, ...originTls(originHost, options.ca) } as AgentConnectOpts)
                  .catch(error => { throw new RouteError(classifyNodeError(routeSignal.aborted ? routeSignal.reason : error) ?? 'proxy', route, error, true) })
              }
              const proxy = new HttpsProxyAgent(proxyUrl(route), { signal: routeSignal, ca: options.ca })
              request.once('proxyConnect', connected)
              const socket = await proxy.connect(request, { ...socketOptions, ...originTls(originHost, options.ca) } as AgentConnectOpts)
              if (proxyStatus !== 200) {
                socket.destroy()
                throw new RouteError(proxyStatus === 407 ? 'proxy-auth' : 'proxy', route, new Error(`Proxy HTTP ${proxyStatus}`))
              }
              return socket
            } catch (error) {
              if (signal.aborted) throw error
              const failure = routeFailure(route, error)
              // A proxy's HTTP answer is final; retry only a connection that could not be established.
              if (index + 1 === list.length || proxyStatus !== undefined || !connectionFailedBeforeRequest(error)) throw failure
            } finally {
              clearTimeout(deadline)
              signal.removeEventListener('abort', cancel)
              request.removeListener('proxyConnect', connected)
            }
          }
          throw new Error('egress: proxy resolver returned no routes')
        }
      }()
      const socket = new WebSocket(url, protocols, { headers, agent })
      // Keep a lifetime error outlet at the Node boundary, including before the facade attaches its listeners.
      socket.on('error', onError)
      const onAbort = () => socket.terminate()
      signal.addEventListener('abort', onAbort, { once: true })
      const detach = () => signal.removeEventListener('abort', onAbort)
      socket.once('open', detach)
      socket.once('close', detach)
      return socket as unknown as globalThis.WebSocket
    },
  }
}
