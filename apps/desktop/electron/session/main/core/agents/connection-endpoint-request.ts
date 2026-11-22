import { EgressError, causeCode, fetchWithEnv } from '@gugu/core/shared/egress';
import type { ConnectionFailureReason } from '@gugu/session-core/workspace-server/agent-config';

const PROBE_TIMEOUT_MS = 10_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'INVALID_CA',
]);

type Result<T> = { ok: true; value: T } | { ok: false; reason: ConnectionFailureReason };

/** Only machine-readable error identities cross this boundary, never provider text or URLs. */
function failureReason(error: unknown, signal: AbortSignal): ConnectionFailureReason {
  if (signal.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError') return 'timeout';
  const code = causeCode(error) ?? '';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED') return 'connection-refused';
  if (CERTIFICATE_CODES.has(code)) return 'certificate';
  // The configured proxy failed (bad URL, refused tunnel) and nothing more specific was underneath.
  return error instanceof EgressError && (error.kind === 'proxy' || error.kind === 'proxy-auth') ? 'proxy' : 'unreachable';
}

/**
 * The request goes out in `env`, the environment the agent using this address would get (its proxy, `NO_PROXY`), through
 * the egress; never this worker's ambient values. `fetchImpl` replaces the transport in tests.
 */
export async function requestEndpoint<T>(
  fetchImpl: typeof globalThis.fetch | undefined,
  url: string,
  init: RequestInit,
  env: NodeJS.ProcessEnv | undefined,
  consume: (response: Response) => Promise<T>,
): Promise<Result<T>> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    // Manual inspection preserves the redirect diagnosis without ever forwarding a credential.
    const request: RequestInit = { ...init, redirect: 'manual', signal };
    const response = await (fetchImpl ? fetchImpl(url, request) : fetchWithEnv(env ?? process.env, url, request));
    const result: Result<T> = REDIRECTS.has(response.status)
      ? { ok: false, reason: 'redirect' }
      : { ok: true, value: await consume(response) };
    if (response.body && !response.bodyUsed) await response.body.cancel();
    return result;
  } catch (error) {
    return { ok: false, reason: failureReason(error, signal) };
  }
}
