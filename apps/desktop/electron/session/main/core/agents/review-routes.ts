import { createHash } from 'node:crypto';
import type { CredentialProxyDivert } from '../../../../sessionpage/platform-credential-proxy';

/**
 * The Auto mode reviewer a user picked on one of their own connections, reviewing a session that runs elsewhere
 * (a Gugu model, or another connection). Claude Code has one base URL per process, so it names the reviewer by a
 * per-session alias; the session's local relay (platform credential relay or custom-model forwarder) sends that one
 * model's requests to the reviewer's connection with the real model id. The alias never collides with a real id.
 */
export type ReviewTarget = { connectionId: string; modelId: string };
type TargetResolver = (connectionId: string) => Promise<{ endpoint: string; apiKey: string } | null>;

const routes = new Map<string, { alias: string; target: ReviewTarget }>();

/** Register this session's diverted reviewer (replacing any earlier one) and return the alias to name it by. */
export function reviewRouteAlias(sessionId: string, target: ReviewTarget): string {
  const alias = `gugu-reviewer-${createHash('sha256').update(`${sessionId}\0${target.connectionId}\0${target.modelId}`).digest('hex').slice(0, 16)}`;
  routes.set(sessionId, { alias, target });
  return alias;
}

export function forgetReviewRoute(sessionId: string): void {
  routes.delete(sessionId);
}

function requestModel(raw: Buffer): unknown {
  try {
    const body = JSON.parse(raw.toString('utf8')) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The relay's divert for one session's request (`suffix` is the path after the base URL, e.g. `/v1/messages`).
 * Only the alias this session registered is diverted; every other model stays on the session's own upstream.
 * A reviewer connection that cannot be read any more fails the request loudly (Claude Code then blocks the action).
 */
export function reviewDivert(sessionId: string | undefined, suffix: string, search: string, resolve: TargetResolver) {
  return async (raw: Buffer<ArrayBuffer>): Promise<CredentialProxyDivert | null> => {
    const route = sessionId ? routes.get(sessionId) : undefined;
    if (!route || requestModel(raw) !== route.alias) return null;
    const target = await resolve(route.target.connectionId);
    if (!target) throw new Error(`Auto mode reviewer connection ${route.target.connectionId} is unavailable`);
    const endpoint = target.endpoint.replace(/\/$/, '');
    return {
      upstream: () => new URL(`${endpoint}${suffix}${search}`),
      credential: async () => target.apiKey,
      credentialHeaders: key => ({ authorization: `Bearer ${key}`, 'x-api-key': key }),
      body: body => Buffer.from(JSON.stringify({ ...(JSON.parse(body.toString('utf8')) as Record<string, unknown>), model: route.target.modelId })),
    };
  };
}
