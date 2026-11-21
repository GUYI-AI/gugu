import { createEgress, type EgressBackend, type EnvironmentFetch, type Egress } from '@gugu/core/shared/egress'
import { nodeEgressBackend } from './node'
import { envRoutes } from './proxy-route'

const ENVIRONMENT_INPUTS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'] as const

/**
 * Requests made with a harness's own credentials (its subscription usage) follow that harness's environment, as its
 * CLI would, including `user:pass` in the proxy URL. Equivalent environments reuse one pool.
 */
export function createEnvironmentFetch(log?: EgressBackend['log']): EnvironmentFetch {
  const transports = new Map<string, Egress>()
  return async (env, input, init) => {
    const inputs = Object.fromEntries(ENVIRONMENT_INPUTS.map(name => [name, env[name]]))
    const key = JSON.stringify(ENVIRONMENT_INPUTS.map(name => inputs[name] ?? ''))
    let transport = transports.get(key)
    if (!transport) {
      transport = createEgress(nodeEgressBackend({ name: 'node-harness-env', routes: envRoutes(inputs, { withCredentials: true }), log }))
      transports.set(key, transport)
    }
    return transport.fetch(input, init)
  }
}
