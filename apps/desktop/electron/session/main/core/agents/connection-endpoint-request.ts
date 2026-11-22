import { EnvHttpProxyAgent } from 'undici';
import type { ConnectionFailureReason } from '@gugu/session-core/workspace-server/agent-config';

const PROBE_TIMEOUT_MS = 10_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'INVALID_CA',
]);

type Result<T> = { ok: true; value: T } | { ok: false; reason: ConnectionFailureReason };

/** Only machine-readable error identities cross this boundary, never provider text or URLs. */
function failureReason(error: unknown, signal: AbortSignal): ConnectionFailureReason {
  const pending: unknown[] = [signal.aborted ? signal.reason : error];
  const seen = new Set<unknown>();
  for (let count = 0; pending.length && count < 32; count++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const code: unknown = Reflect.get(current, 'code');
    const name: unknown = Reflect.get(current, 'name');
    if (name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT'
      || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return 'timeout';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
    if (code === 'ECONNREFUSED') return 'connection-refused';
    if (typeof code === 'string' && CERTIFICATE_CODES.has(code)) return 'certificate';
    pending.push(Reflect.get(current, 'cause'));
    const errors: unknown = Reflect.get(current, 'errors');
    if (Array.isArray(errors)) pending.push(...errors.slice(0, 32));
  }
  return 'unreachable';
}

/** Explicit values prevent undici falling back to this worker's ambient proxy configuration. */
function proxyOptions(env: NodeJS.ProcessEnv) {
  const all = env.all_proxy ?? env.ALL_PROXY ?? '';
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? all;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? httpProxy;
  for (const value of [httpProxy, httpsProxy]) {
    if (value && !['http:', 'https:'].includes(new URL(value).protocol)) throw new Error('Unsupported proxy protocol');
  }
  return { httpProxy, httpsProxy, noProxy: env.no_proxy ?? env.NO_PROXY ?? '' };
}

/** Keep the dispatcher alive through body reads, then close all of its sockets on every outcome. */
export async function requestEndpoint<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  env: NodeJS.ProcessEnv | undefined,
  consume: (response: Response) => Promise<T>,
): Promise<Result<T>> {
  let dispatcher: EnvHttpProxyAgent;
  try { dispatcher = new EnvHttpProxyAgent(proxyOptions(env ?? process.env)); }
  catch { return { ok: false, reason: 'proxy' }; }
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    // Manual inspection preserves the redirect diagnosis without ever forwarding a credential.
    const request: RequestInit & { dispatcher: EnvHttpProxyAgent } = { ...init, dispatcher, redirect: 'manual', signal };
    response = await fetchImpl(url, request);
    const result: Result<T> = REDIRECTS.has(response.status)
      ? { ok: false, reason: 'redirect' }
      : { ok: true, value: await consume(response) };
    if (response.body && !response.bodyUsed) await response.body.cancel();
    return result;
  } catch (error) {
    return { ok: false, reason: failureReason(error, signal) };
  } finally {
    await dispatcher.destroy();
  }
}
