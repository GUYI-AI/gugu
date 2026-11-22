import { isIP } from 'node:net';
import { fetchWithEnv, type EgressFetchInit } from '@gugu/core/shared/egress';
import { installerEnvironment } from '../../../../egress/installer';

export type InstallFetch = (url: string, init?: EgressFetchInit) => Promise<Response>;

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

/**
 * A sample takes the route mise gets for the artifact's origin (installerEnvironment); never consults process.env.
 * Redirects keep the first request's route, as every egress request does.
 */
export function createInstallTransport(env: NodeJS.ProcessEnv): { fetch: InstallFetch } {
  const fetcher: InstallFetch = async (url, init = {}) => {
    const installerEnv = await installerEnvironment(url, env);
    // Refuse inputs mise would read differently; the route itself comes from the egress.
    installProxyRoute(installerEnv, url);
    return fetchWithEnv(installerEnv, url, init);
  };
  return { fetch: fetcher };
}
