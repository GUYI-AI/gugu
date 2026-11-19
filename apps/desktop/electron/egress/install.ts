import { powerMonitor, session } from 'electron'
import type { EgressBackend } from '@gugu/core/shared/egress'
import { createLogger } from '../lib/logger'
import { installNodeEgress } from './install-node'
import { cachedProxyAnswers, chromiumRoutes } from './proxy-route'

const log: EgressBackend['log'] = ({ kind, host, backend, cause, proxies }) => {
  // Errors can include full request/proxy URLs. Record codes and route kind without leaking credentials or query strings.
  const detail = cause instanceof Error ? cause as Error & { code?: string; route?: string } : null
  createLogger('egress').warn({ kind, host, backend, proxies, route: detail?.route ?? backend, cause: detail?.name, code: detail?.code }, 'egress: no answer')
}

/** Bounds how long a proxy switched on or off keeps the old route for an origin; see cachedProxyAnswers. */
const PROXY_ANSWER_TTL_MS = 5_000

/** Install before the first network operation in each host entrypoint. Desktop routes come from Chromium. */
export function installHostEgress(): void {
  if (process.type !== 'browser') return installNodeEgress({ log })
  // @@@proxy-config-ready - right after ready, Chromium answers resolveProxy with DIRECT before it has read the proxy
  // configuration (Electron 45: one wrong answer within ~40–60 ms of ready). One awaited reload makes the first answer
  // the configured one; it costs ~30–50 ms, paid only by requests made in that window.
  const configured = session.defaultSession.forceReloadProxyConfig()
  const answers = cachedProxyAnswers(url => configured.then(() => session.defaultSession.resolveProxy(url)), PROXY_ANSWER_TTL_MS)
  powerMonitor.on('resume', answers.clear)
  installNodeEgress({ routes: chromiumRoutes(answers.resolve), name: 'node-system', log })
}
