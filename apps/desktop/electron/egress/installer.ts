import { proxyRoutesFor } from './proxy-route'
import { withLoopbackNoProxy } from '@gugu/session-core/agents/agent-env'
import { createLogger } from '../lib/logger'

/** Only Gugu-owned installers use this adaptation; never pass this environment to a harness. */
export async function installerEnvironment(origin: string, source: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = withLoopbackNoProxy(source)
  // Explicit shell routes are authoritative; only fill an installer that has none.
  if (Object.entries(source).some(([key, value]) => /^(https?|all)_proxy$/i.test(key) && value)) return env
  const [route] = await proxyRoutesFor(new URL(origin).origin)
  if (!route) throw new Error('Installer proxy resolver returned no routes')
  if (route.kind === 'direct') return env
  if (route.kind !== 'http' && route.kind !== 'https') {
    // The installer only understands HTTP(S) proxy variables. Going direct behind a SOCKS-only proxy would fail later,
    // somewhere less clear; say why now, in the install's own failure.
    createLogger('egress/installer').warn({ route: route.kind }, 'Installer cannot use this system proxy')
    throw new Error(`系统代理是 ${route.kind.toUpperCase()} 代理，安装程序只能经 HTTP 代理下载。请在代理软件里打开 HTTP 代理（或混合端口），或者在环境变量里设 HTTPS_PROXY 指向一个 HTTP 代理后重试。`)
  }
  const proxy = new URL(`${route.kind}://${route.host.includes(':') ? `[${route.host}]` : route.host}:${route.port}`)
  env.HTTP_PROXY = env.http_proxy = env.HTTPS_PROXY = env.https_proxy = proxy.href
  return env
}
