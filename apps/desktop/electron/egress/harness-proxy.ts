/**
 * System proxy → agent processes and their installer (#6892).
 *
 * Many users run only a system proxy, without TUN (Clash / Surge "system proxy" mode, Windows Internet Options).
 * agy (Go) and the Node harnesses read only `HTTP(S)_PROXY`-style variables, never the system proxy (2026-10-02 mac1:
 * agy went straight to Google's 443); so does mise on Linux (thinkpad: install stuck in download).
 *
 * **One source**: Chromium's `session.resolveProxy`, parsed like every other egress answer (`parseProxyAnswer`). Asked
 * once when the host boots (`resolveSystemProxy`), kept here. The headless shim answers DIRECT: its proxy can only be
 * its environment, which the agent inherits already.
 *
 * **Only the two kinds of child that need it**: `buildAgentEnv` (panel, terminal and probe legs, and the mise install
 * that takes its env) and the agent-config worker's environment. ❌ Never into the main process `process.env`: the
 * user's own terminals and libraries reading proxy variables there follow the system proxy and its bypass list, which
 * variables cannot express.
 *
 * **Fill, never change**: if the environment being spawned (login shell and agent settings included) has any proxy
 * variable, nothing is touched.
 */

import { hasProxyVar, parseProxyAnswer, type ProxyRoute } from './proxy-route'

/**
 * A variable holds one proxy, but a PAC can route per target. Ask once for an origin these children really reach
 * (mise downloads and harness vendors are this kind of https target).
 */
const PROBE_URL = 'https://dl.google.com/'

/** Loopback always goes direct: Gugu's MCP and hooks are on 127.0.0.1 and break behind a proxy. */
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1'

export type SystemProxyReading =
  | { proxy: string }
  | { proxy: null; reason: 'direct' | 'unsupported'; detail: string }

let reading: SystemProxyReading | null = null

/**
 * The first route only (Chromium tries them in order). SOCKS is not translated: many clients do not accept socks:// in
 * `HTTP(S)_PROXY`, so it is reported as unsupported, ❌ never guessed.
 */
export function proxyFromAnswer(answer: string): SystemProxyReading {
  let route: ProxyRoute
  // An answer the egress cannot parse is reported like SOCKS; the boot that asks must not fail on it.
  try { route = parseProxyAnswer(answer) } catch { return { proxy: null, reason: 'unsupported', detail: answer } }
  if (!route) return { proxy: null, reason: 'direct', detail: answer }
  return route.startsWith('http') ? { proxy: route } : { proxy: null, reason: 'unsupported', detail: answer }
}

/** Called once at host boot, before any agent or worker starts. */
export async function resolveSystemProxy(resolveProxy: (url: string) => Promise<string>): Promise<SystemProxyReading> {
  reading = proxyFromAnswer(await resolveProxy(PROBE_URL))
  return reading
}

/**
 * The variables to add to this environment; empty when none should be. `alsoConfigured` is where else the user may have
 * set a proxy (the worker inherits the main process env, while a proxy in ~/.zshrc is only in the login shell snapshot).
 */
export function systemProxyFill(
  env: Record<string, string | undefined>,
  alsoConfigured?: Record<string, string> | null
): Record<string, string> {
  if (!reading?.proxy || hasProxyVar(env) || hasProxyVar(alsoConfigured)) return {}
  return {
    HTTPS_PROXY: reading.proxy,
    HTTP_PROXY: reading.proxy,
    ...(env.NO_PROXY?.trim() || env.no_proxy?.trim() ? {} : { NO_PROXY: LOOPBACK_NO_PROXY }),
  }
}
