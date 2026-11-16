/**
 * Where a request to a URL goes: the one place that turns a proxy answer into routes.
 *
 * Desktop: ask Chromium (`session.resolveProxy`) per URL, every time it is needed — system proxy, PAC and its bypass
 * list included, and a proxy switched on after start counts on the next request. A headless host or server has no
 * Chromium; its only source is the environment (`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`).
 * Loopback always goes direct: those are Gugu's own local endpoints and the user's local model servers.
 */

export type ProxyRoute =
  | { kind: 'direct' }
  | { kind: 'http' | 'https' | 'socks5' | 'socks4'; host: string; port: number }

export type RoutesFor = (url: string) => Promise<ProxyRoute[]>

const DIRECT: ProxyRoute = { kind: 'direct' }

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)
}

/**
 * Chromium's answer, in order: `PROXY h:p`, `HTTPS h:p`, `SOCKS5 h:p`, `SOCKS h:p` (v4), `DIRECT`, separated by `;`
 * with or without a space. Unknown entries are dropped (Chromium skips them too); an empty list means direct.
 */
export function parseProxyAnswer(answer: string): ProxyRoute[] {
  const routes: ProxyRoute[] = []
  for (const item of answer.split(';')) {
    const [scheme = '', hostPort = ''] = item.trim().split(/\s+/)
    const kind = scheme.toUpperCase()
    if (kind === 'DIRECT') { routes.push(DIRECT); continue }
    const at = hostPort.lastIndexOf(':')
    const host = hostPort.slice(0, at).replace(/^\[|\]$/g, ''), port = Number(hostPort.slice(at + 1))
    if (!host || !Number.isInteger(port)) continue
    const mapped = ({ PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5', SOCKS: 'socks4', SOCKS4: 'socks4' } as const)[kind as 'PROXY']
    if (mapped) routes.push({ kind: mapped, host, port })
  }
  return routes.length ? routes : [DIRECT]
}

export function chromiumRoutes(resolveProxy: (url: string) => Promise<string>): RoutesFor {
  return async (url) => {
    if (isLoopbackHost(new URL(url).hostname)) return [DIRECT]
    return parseProxyAnswer(await resolveProxy(url))
  }
}

/** Environment proxies the way curl reads them; `NO_PROXY` entries are suffixes, `*` means everything. */
export function envRoutes(env: NodeJS.ProcessEnv = process.env): RoutesFor {
  const read = (name: string) => env[name] ?? env[name.toLowerCase()] ?? ''
  return async (url) => {
    const target = new URL(url)
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (isLoopbackHost(host)) return [DIRECT]
    const noProxy = read('NO_PROXY').split(',').map((entry) => entry.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean)
    if (noProxy.some((entry) => entry === '*' || host === entry || host.endsWith(`.${entry}`))) return [DIRECT]
    const secure = target.protocol === 'https:' || target.protocol === 'wss:'
    const raw = (secure ? read('HTTPS_PROXY') : read('HTTP_PROXY')) || read('ALL_PROXY')
    if (!raw) return [DIRECT]
    const proxy = new URL(raw.includes('://') ? raw : `http://${raw}`)
    const kind = ({ 'http:': 'http', 'https:': 'https', 'socks5:': 'socks5', 'socks5h:': 'socks5', 'socks4:': 'socks4', 'socks:': 'socks5' } as const)[proxy.protocol as 'http:']
    if (!kind) return [DIRECT]
    const port = Number(proxy.port) || (kind === 'https' ? 443 : kind === 'http' ? 80 : 1080)
    return [{ kind, host: proxy.hostname.replace(/^\[|\]$/g, ''), port }]
  }
}
