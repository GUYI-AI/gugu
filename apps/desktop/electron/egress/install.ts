import { powerMonitor, session } from 'electron'
import { causeCode, type EgressBackend } from '@gugu/core/shared/egress'
import { createLogger } from '../lib/logger'
import { installNodeEgress } from './install-node'
import { cachedProxyAnswers, chromiumRoutes } from './proxy-route'

// Errors can include full request/proxy URLs: record the kind and code only, never credentials or query strings.
const log: EgressBackend['log'] = ({ kind, host, backend, cause }) => {
  createLogger('egress').warn({ kind, host, backend, cause: cause instanceof Error ? cause.name : undefined, code: causeCode(cause) }, 'egress: no answer')
}

/** Bounds how long a proxy switched on or off keeps the old route for an origin; see cachedProxyAnswers. */
const PROXY_ANSWER_TTL_MS = 5_000

/** Install before the first network operation in each host entrypoint. Desktop routes come from Chromium. */
export function installHostEgress(): void {
  if (process.type !== 'browser') return installNodeEgress({ log })
  // @@@proxy-config-ready - right after ready Chromium answers DIRECT before reading the proxy config; one reload first.
  const configured = session.defaultSession.forceReloadProxyConfig()
  const answers = cachedProxyAnswers(url => configured.then(() => session.defaultSession.resolveProxy(url)), PROXY_ANSWER_TTL_MS)
  powerMonitor.on('resume', answers.clear)
  installNodeEgress({ routes: chromiumRoutes(answers.resolve), name: 'node-system', log })
}
