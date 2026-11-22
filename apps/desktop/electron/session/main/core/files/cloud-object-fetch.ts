import { getCACertificates } from 'node:tls'
import { session } from 'electron'
import { Agent, ProxyAgent, type Dispatcher } from 'undici'
import { proxyFromPac } from '@main/utils/systemProxyEnv'

/**
 * @@@cloud-object-transport - every desktop read of a cloud object's bytes (a download, a preview, a `<video>`, an agent or
 * App save) goes out here, in main. Chromium keeps one HTTP/2 connection per origin, so ranged GETs of one file read in
 * parallel would share it; Node's HTTP/1.1 opens one connection per request (11-22: 200 MB 4.0 → 5.4–5.7 MB/s).
 * What Chromium did for these requests is kept: the route is the one Electron resolves for the address (system proxy, PAC),
 * and the trusted roots are Node's own plus the system's (a corporate root the browser trusted is trusted here).
 * A route Node cannot take (SOCKS, an unreadable answer) is refused; nothing ever connects directly in its place.
 */
export class CloudObjectRouteError extends Error {
  readonly code = 'unsupported_proxy'
  constructor(readonly route: string) { super(`Cloud object route not supported: ${route}`); this.name = 'CloudObjectRouteError' }
}

let roots: string[] | undefined
const trusted = () => roots ??= [...new Set([...getCACertificates('default'), ...getCACertificates('system')])]

export function createCloudObjectFetch(resolveProxy: (url: string) => Promise<string> = url => session.defaultSession.resolveProxy(url)): typeof fetch {
  const dispatchers = new Map<string, Dispatcher>()
  const dispatcher = (proxy: string | null) => {
    const key = proxy ?? 'DIRECT'
    let found = dispatchers.get(key)
    if (!found) {
      found = proxy ? new ProxyAgent({ uri: proxy, requestTls: { ca: trusted() }, proxyTls: { ca: trusted() } }) : new Agent({ connect: { ca: trusted() } })
      dispatchers.set(key, found)
    }
    return found
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const answer = await resolveProxy(url)
    if (!answer.trim()) throw new CloudObjectRouteError('(no answer)')
    const route = proxyFromPac(answer)
    if (route.proxy === null && route.reason !== 'direct') throw new CloudObjectRouteError(route.detail || answer)
    // Node's fetch takes a local undici dispatcher (as install-source-transport does); the global one is never changed.
    return fetch(url, { ...init, dispatcher: dispatcher(route.proxy) } as RequestInit & { dispatcher: Dispatcher })
  }) as typeof fetch
}

/** The one main-process transport for cloud object bytes. */
export const cloudObjectFetch = createCloudObjectFetch()
