import { hasProxyVar, proxyRoutesFor } from './proxy-route'
import { withLoopbackNoProxy } from '@gugu/session-core/agents/agent-env'

/**
 * Only Gugu-owned installers use this adaptation; never pass this environment to a harness. Installers that run on
 * Node trust the OS certificate store, as the egress does (TLS-intercepting corporate proxies re-sign with a root
 * that only the OS store has).
 */
export async function installerEnvironment(origin: string, source: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...withLoopbackNoProxy(source), NODE_USE_SYSTEM_CA: '1' }
  // Explicit shell routes are authoritative; only fill an installer that has none. It speaks HTTP proxies only.
  if (hasProxyVar(source)) return env
  const route = await proxyRoutesFor(new URL(origin).origin)
  if (route?.startsWith('http')) env.HTTP_PROXY = env.http_proxy = env.HTTPS_PROXY = env.https_proxy = route
  return env
}
