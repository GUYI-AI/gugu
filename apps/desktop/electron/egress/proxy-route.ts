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

/** Where one request goes: `null` is direct, otherwise the proxy as a URL (`http:`, `https:` or `socks5:`). */
export type ProxyRoute = string | null
export type RoutesFor = (url: string) => Promise<ProxyRoute>
export class ProxyRouteError extends Error {
  constructor(message: string, cause?: unknown) { super(message, { cause }); this.name = 'ProxyRouteError' }
}

let installedRoutes: RoutesFor | undefined
export function installProxyRoutes(routes: RoutesFor): void { installedRoutes = routes }
export function proxyRoutesFor(url: string): Promise<ProxyRoute> {
  if (!installedRoutes) throw new Error('egress: proxy resolver is not installed')
  return installedRoutes(url)
}

const PAC_SCHEMES: Record<string, string | undefined> = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5', SOCKS: 'socks5' }

/**
 * Chromium's answer (`PROXY h:p; HTTPS h:p; SOCKS5 h:p; DIRECT`): the first entry this transport speaks is used, as
 * VS Code does; later entries are not tried. `SOCKS` is taken as SOCKS5. An answer with nothing usable fails rather
 * than silently changing the user's network route.
 */
export function parseProxyAnswer(answer: string): ProxyRoute {
  for (const item of answer.split(';')) {
    const [type = '', target = ''] = item.trim().split(/\s+/)
    if (type.toUpperCase() === 'DIRECT') return null
    const scheme = PAC_SCHEMES[type.toUpperCase()]
    if (!scheme) continue
    if (!/^(\[[^\]]+\]|[^:\s]+):\d{1,5}$/.test(target) || !URL.canParse(`${scheme}://${target}`)) throw new ProxyRouteError('Invalid proxy endpoint')
    return `${scheme}://${target}`
  }
  throw new ProxyRouteError('Unsupported proxy configuration')
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
    if (isLoopbackHost(new URL(url).hostname)) return null
    try { return parseProxyAnswer(await resolveProxy(url)) }
    catch (error) { throw new ProxyRouteError('System proxy resolution failed', error) }
  }
}

const PROXY_VARS = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'])

/** Whether this environment already names a proxy (any case of HTTP(S)_PROXY / ALL_PROXY). */
export function hasProxyVar(env: Record<string, string | undefined> | null | undefined): boolean {
  return Object.entries(env ?? {}).some(([key, value]) => PROXY_VARS.has(key.toUpperCase()) && Boolean(value?.trim()))
}

function envValue(env: NodeJS.ProcessEnv, name: string): string { return env[name.toLowerCase()] ?? env[name] ?? '' }

const ENV_SCHEMES: Record<string, string | undefined> = { 'http:': 'http', 'https:': 'https', 'socks5:': 'socks5', 'socks5h:': 'socks5', 'socks:': 'socks5' }

/** `withCredentials`: only a harness's own environment (fetchWithEnv) keeps the URL's user:pass, as its CLI would. */
function environmentProxy(target: URL, env: NodeJS.ProcessEnv, withCredentials: boolean): ProxyRoute {
  const secure = target.protocol === 'https:' || target.protocol === 'wss:'
  const raw = envValue(env, secure ? 'HTTPS_PROXY' : 'HTTP_PROXY') || envValue(env, 'ALL_PROXY')
  if (!raw) return null
  let proxy: URL
  try { proxy = new URL(raw.includes('://') ? raw : `http://${raw}`) }
  catch (error) { throw new ProxyRouteError('Invalid environment proxy', error) }
  const scheme = ENV_SCHEMES[proxy.protocol]
  if (!scheme) throw new ProxyRouteError('Unsupported environment proxy scheme')
  const credentials = withCredentials && (proxy.username || proxy.password) ? `${proxy.username}:${proxy.password}@` : ''
  return `${scheme}://${credentials}${proxy.host}`
}

/**
 * Environment proxies the way curl reads them; `NO_PROXY` entries are suffixes, `*` means everything. Host processes
 * (`withCredentials` false) do not authenticate to a proxy: a 407 is reported as proxy-auth.
 */
export function envRoutes(env: NodeJS.ProcessEnv = process.env, { withCredentials = false } = {}): RoutesFor {
  return async (url) => {
    const target = new URL(url)
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (isLoopbackHost(host)) return null
    const targetPort = target.port || (target.protocol === 'https:' || target.protocol === 'wss:' ? '443' : '80')
    const noProxy = envValue(env, 'NO_PROXY').split(/[,\s]+/).filter(Boolean)
    if (noProxy.some(entry => {
      if (entry === '*') return true
      const endpoint = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry.toLowerCase())
      if (endpoint?.[2] && endpoint[2] !== targetPort) return false
      const name = (endpoint?.[1] ?? entry).replace(/^\[|\]$/g, '').replace(/^\*?\./, '').toLowerCase()
      return host === name || host.endsWith(`.${name}`)
    })) return null
    return environmentProxy(target, env, withCredentials)
  }
}
