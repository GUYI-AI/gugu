import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import { isIP } from 'node:net';

export type InstallFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Do not measure a different route when the transport cannot reproduce mise's environment. */
export class UnmeasurableInstallTransport extends Error {}

function value(env: NodeJS.ProcessEnv, key: string): string {
  const upper = env[key];
  const lower = env[key.toLowerCase()];
  // Libraries disagree about case precedence. Conflicting inputs cannot give a trustworthy race.
  if (upper !== undefined && lower !== undefined && upper !== lower) throw new UnmeasurableInstallTransport('conflicting-proxy-case');
  return upper ?? lower ?? '';
}

export function installProxyRoute(env: NodeJS.ProcessEnv, url: string): string | null {
  if (env.SSL_CERT_FILE || env.SSL_CERT_DIR) throw new UnmeasurableInstallTransport('custom-trust-store');
  const destination = new URL(url);
  if (!['http:', 'https:'].includes(destination.protocol)) throw new UnmeasurableInstallTransport('unsupported-url-scheme');
  const host = destination.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const bypass = value(env, 'NO_PROXY').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  for (const entry of bypass) {
    if (entry === '*') return null;
    // Support the common domain/IP rules shared with mise/reqwest. Do not reinterpret CIDR,
    // port-qualified domains or nonstandard wildcards as a different bypass policy.
    if (entry.includes('/') || (entry.includes(':') && !isIP(entry)) || entry.includes('*') || /\s/.test(entry)) {
      throw new UnmeasurableInstallTransport('unsupported-no-proxy');
    }
  }
  if (bypass.some((entry) => host === entry.replace(/^\./, '') || (!isIP(entry) && host.endsWith('.' + entry.replace(/^\./, ''))))) return null;
  const configured = value(env, destination.protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY') || value(env, 'ALL_PROXY');
  if (!configured) return null;
  let proxy: URL;
  try { proxy = new URL(configured.includes('://') ? configured : 'http://' + configured); }
  catch { throw new UnmeasurableInstallTransport('invalid-proxy'); }
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new UnmeasurableInstallTransport('unsupported-proxy-scheme');
  return proxy.href;
}

/** Per-operation agents; never consult process.env or change the global dispatcher. */
export function createInstallTransport(env: NodeJS.ProcessEnv): { fetch: InstallFetch; close(): Promise<void> } {
  const agents = new Map<string, Dispatcher>();
  const fetcher: InstallFetch = async (url, init = {}) => {
    let next = url;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      init.signal?.throwIfAborted();
      const proxy = installProxyRoute(env, next);
      const key = proxy ?? 'direct';
      let dispatcher = agents.get(key);
      if (!dispatcher) {
        dispatcher = proxy ? new ProxyAgent(proxy) : new Agent();
        agents.set(key, dispatcher);
      }
      // Node's fetch accepts a local Undici dispatcher. The same env is passed to mise unchanged.
      const response = await fetch(next, { ...init, redirect: 'manual', dispatcher } as RequestInit & { dispatcher: Dispatcher });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirect === 5) throw new UnmeasurableInstallTransport('invalid-redirect');
      next = new URL(location, next).href;
    }
    throw new UnmeasurableInstallTransport('invalid-redirect');
  };
  return { fetch: fetcher, async close() { await Promise.all([...agents.values()].map((agent) => agent.destroy())); } };
}
