/**
 * Where a request to a URL goes: the one place that turns a proxy answer into routes.
 *
 * Desktop: ask Chromium (`session.resolveProxy`) per origin — system proxy, PAC and its bypass list included. Answers
 * are kept for a few seconds (`cachedProxyAnswers`), so a proxy switched on after start counts within that window. A headless host or server has no
 * Chromium; its only source is the environment (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`).
 * Loopback always goes direct: those are Gugu's own local endpoints and the user's local model servers.
 */

import { isLoopbackHost } from '@gugu/core/shared/loopback'
export { isLoopbackHost } from '@gugu/core/shared/loopback'

export type ProxyServerKind = 'http' | 'https' | 'socks5' | 'socks4'
export type ProxyServer = { kind: ProxyServerKind; host: string; port: number; username?: string; password?: string }
export type ProxyRoute = { kind: 'direct' } | ProxyServer

/** Endpoint display only: no userinfo, URL path, query, or PAC source. Keep explicit ports, including defaults. */
export function proxyEndpoints(routes: readonly ProxyRoute[]): string[] {
  return routes.flatMap(route => {
    if (route.kind === 'direct') return []
    const host = new URL(`${route.kind}://${route.host.includes(':') ? `[${route.host}]` : route.host}:${route.port}`).hostname
    return [`${route.kind}://${host}:${route.port}`]
  })
}

export type RoutesFor = (url: string) => Promise<ProxyRoute[]>
export class ProxyRouteError extends Error {
  constructor(message: string, cause?: unknown) { super(message, { cause }); this.name = 'ProxyRouteError' }
}

let installedRoutes: RoutesFor | undefined
export function installProxyRoutes(routes: RoutesFor): void { installedRoutes = routes }
export function proxyRoutesFor(url: string): Promise<ProxyRoute[]> {
  if (!installedRoutes) throw new Error('egress: proxy resolver is not installed')
  return installedRoutes(url)
}

const DIRECT: ProxyRoute = { kind: 'direct' }

/**
 * Chromium's answer, in order: `PROXY h:p`, `HTTPS h:p`, `SOCKS5 h:p`, `SOCKS h:p` (v4), `DIRECT`, separated by `;`
 * with or without a space. Invalid entries fail rather than silently changing the user's network route.
 */
export function parseProxyAnswer(answer: string): ProxyRoute[] {
  const routes: ProxyRoute[] = []
  for (const item of answer.split(';')) {
    const [scheme = '', hostPort = ''] = item.trim().split(/\s+/)
    const kind = scheme.toUpperCase()
    if (kind === 'DIRECT') { routes.push(DIRECT); continue }
    const at = hostPort.lastIndexOf(':')
    const host = hostPort.slice(0, at).replace(/^\[|\]$/g, ''), port = Number(hostPort.slice(at + 1))
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyRouteError('Invalid proxy endpoint')
    const mapped = ({ PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5', SOCKS: 'socks4', SOCKS4: 'socks4' } as Record<string, ProxyServerKind | undefined>)[kind]
    if (!mapped) throw new ProxyRouteError('Unsupported proxy configuration')
    routes.push({ kind: mapped, host, port })
  }
  if (!routes.length) throw new ProxyRouteError('Proxy resolver returned no routes')
  return routes
}

/**
 * @@@proxy-answer-cache - one `resolveProxy` answer per `scheme://host:port`, kept `ttlMs`.
 * Measured on Electron 45: a fixed proxy or a rules-only PAC answers in
 * ~0.04–0.1 ms, but a PAC that calls `dnsResolve` took p50 2.6 ms / p90 up to 325 ms for a repeated origin and
 * 200–380 ms for a new one. Electron has no proxy-changed event, and switching a proxy (e.g. Clash's mode) changes no
 * network interface, so the window must stay short; resume from sleep empties it. Failures are never kept.
 */
export function cachedProxyAnswers(resolve: (url: string) => Promise<string>, ttlMs: number, now: () => number = Date.now) {
  const answers = new Map<string, { at: number; answer: Promise<string> }>()
  const MAX = 512
  return {
    resolve(url: string): Promise<string> {
      const target = new URL(url)
      const key = `${target.protocol}//${target.host}`
      const kept = answers.get(key)
      if (kept && now() - kept.at < ttlMs) return kept.answer
      if (answers.size >= MAX) answers.clear()
      const answer = resolve(url)
      answers.set(key, { at: now(), answer })
      answer.catch(() => { if (answers.get(key)?.answer === answer) answers.delete(key) })
      return answer
    },
    clear(): void { answers.clear() },
  }
}

export function chromiumRoutes(resolveProxy: (url: string) => Promise<string>): RoutesFor {
  return async (url) => {
    if (isLoopbackHost(new URL(url).hostname)) return [DIRECT]
    try { return parseProxyAnswer(await resolveProxy(url)) }
    catch (error) { throw new ProxyRouteError('System proxy resolution failed', error) }
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string): string { return env[name.toLowerCase()] ?? env[name] ?? '' }

function environmentProxyValue(target: URL, env: NodeJS.ProcessEnv): string {
  const secure = target.protocol === 'https:' || target.protocol === 'wss:'
  return envValue(env, secure ? 'HTTPS_PROXY' : 'HTTP_PROXY') || envValue(env, 'ALL_PROXY')
}

/** `withCredentials`: only a harness's own environment (fetchWithEnv) keeps the URL's user:pass, as its CLI would. */
function environmentProxy(target: URL, env: NodeJS.ProcessEnv, withCredentials: boolean): ProxyServer | null {
  const raw = environmentProxyValue(target, env)
  if (!raw) return null
  let proxy: URL
  try { proxy = new URL(raw.includes('://') ? raw : `http://${raw}`) }
  catch (error) { throw new ProxyRouteError('Invalid environment proxy', error) }
  const kind = ({ 'http:': 'http', 'https:': 'https', 'socks5:': 'socks5', 'socks5h:': 'socks5', 'socks4:': 'socks4', 'socks:': 'socks5' } as Record<string, ProxyServerKind | undefined>)[proxy.protocol]
  if (!kind) throw new ProxyRouteError('Unsupported environment proxy scheme')
  const port = Number(proxy.port) || (kind === 'https' ? 443 : kind === 'http' ? 80 : 1080)
  const server: ProxyServer = { kind, host: proxy.hostname.replace(/^\[|\]$/g, ''), port }
  return withCredentials && (proxy.username || proxy.password) ? { ...server, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } : server
}

/**
 * Environment proxies the way curl reads them; `NO_PROXY` entries are suffixes, `*` means everything. Host processes
 * (`withCredentials` false) do not authenticate to a proxy: a 407 is reported as proxy-auth.
 */
export function envRoutes(env: NodeJS.ProcessEnv = process.env, { withCredentials = false } = {}): RoutesFor {
  return async (url) => {
    const target = new URL(url)
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (isLoopbackHost(host)) return [DIRECT]
    const targetPort = target.port || (target.protocol === 'https:' || target.protocol === 'wss:' ? '443' : '80')
    const noProxy = envValue(env, 'NO_PROXY').split(/[,\s]+/).filter(Boolean)
    if (noProxy.some(entry => {
      if (entry === '*') return true
      const endpoint = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry.toLowerCase())
      if (endpoint?.[2] && endpoint[2] !== targetPort) return false
      const name = (endpoint?.[1] ?? entry).replace(/^\[|\]$/g, '').replace(/^\*?\./, '').toLowerCase()
      return host === name || host.endsWith(`.${name}`)
    })) return [DIRECT]
    return [environmentProxy(target, env, withCredentials) ?? DIRECT]
  }
}
