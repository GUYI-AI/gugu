/**
 * Installs the egress of this host process. Call first, before anything reaches the network.
 *
 * - Desktop main process (real Electron, `process.type === 'browser'`): the desktop backend.
 * - Headless session host and server (Node with an electron shim): the Node backend, routed by the environment —
 *   they have no Chromium to ask, so `HTTPS_PROXY`/`NO_PROXY` are the only source, and the OS trust store is added.
 */
import { createEgress, installEgress, type Egress, type EgressBackend } from '@gugu/core/shared/egress'
import { createLogger } from '../lib/logger'
import { installSystemCertificates, nodeEgressBackend } from './node'
import { envRoutes } from './proxy-route'

const log: EgressBackend['log'] = ({ kind, host, backend, cause }) => {
  createLogger('egress').warn({ kind, host, backend, cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) }, 'egress: no answer')
}

function headlessEgress(): Egress {
  installSystemCertificates()
  return createEgress(nodeEgressBackend({ name: 'node-env', routes: envRoutes(), log }))
}

/** The desktop backend. Until a desktop backend is chosen it is the headless one. */
function desktopEgress(): Egress {
  return headlessEgress()
}

export function installHostEgress(): void {
  installEgress(process.type === 'browser' ? desktopEgress() : headlessEgress())
}
