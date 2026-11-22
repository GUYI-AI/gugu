import { createEgress, installEgress, installEnvironmentFetch, type EgressBackend } from '@gugu/core/shared/egress'
import { installSystemCertificates, nodeEgressBackend } from './node'
import { createEnvironmentFetch } from './environment'
import { envRoutes, installProxyRoutes, type RoutesFor } from './proxy-route'

const stderrLog: EgressBackend['log'] = ({ kind, host, backend }) => {
  process.stderr.write(`${JSON.stringify({ event: 'egress: no answer', kind, host, backend })}\n`)
}

/**
 * The one transport of every host process: undici and ws, with the system roots added to Node's trust store. Routes
 * come from the environment (headless session host, server, CLI) or, on desktop, from Chromium (install.ts).
 */
export function installNodeEgress({ routes = envRoutes(), name = 'node-env', log = stderrLog }: { routes?: RoutesFor; name?: string; log?: EgressBackend['log'] } = {}): void {
  installSystemCertificates()
  installProxyRoutes(routes)
  installEgress(createEgress(nodeEgressBackend({ name, routes, log })))
  installEnvironmentFetch(createEnvironmentFetch(log))
}

/**
 * Worker processes make requests only on behalf of a harness, in its environment. They install nothing else, so a host
 * request added to a worker later fails loudly ("no backend installed") instead of leaving without the system proxy.
 */
export function installWorkerEgress(): void {
  installSystemCertificates()
  installEnvironmentFetch(createEnvironmentFetch(stderrLog))
}
