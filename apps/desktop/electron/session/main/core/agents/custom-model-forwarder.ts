import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { modelProtocolSchema, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import { proxyPlatformCredentialRequest } from '../../../../sessionpage/platform-credential-proxy';

/** `priority`: the session asked for Fast on a model and protocol that carry it. */
type Target = { endpoint: string; apiKey: string; priority?: boolean };
type TargetResolver = (connectionId: string, protocol: ModelProtocol, routeId?: string, sessionId?: string) => Promise<Target | null>;
/** `sessions`: one local key per session (key → session id), so a request says which session sent it. */
type Forwarder = { server: Server; endpoint: string; apiKey: string; sessions: Map<string, string> };
let pending: Promise<Forwarder> | undefined;

/** One address per stored endpoint for the life of this app process. */
export function customModelRoute(root: string, connectionId: string, protocol: ModelProtocol, routeId?: string): string {
  return `${root}/r/${connectionId}/${protocol}${routeId ? `~${routeId}` : ''}`;
}

export async function customModelForwarder(resolveTarget: TargetResolver): Promise<{ endpoint: string; apiKey: string }> {
  if (!pending) {
    const started = start(resolveTarget);
    pending = started;
    void started.catch(() => { if (pending === started) pending = undefined; });
  }
  const { endpoint, apiKey } = await pending;
  return { endpoint, apiKey };
}

/** The local key a session's harness sends; the same session always gets the same key while the forwarder lives. */
export async function customModelSessionKey(resolveTarget: TargetResolver, sessionId: string): Promise<string> {
  await customModelForwarder(resolveTarget);
  const forwarder = await pending!;
  for (const [key, owner] of forwarder.sessions) if (owner === sessionId) return key;
  const key = localKey();
  forwarder.sessions.set(key, sessionId);
  return key;
}

const localKey = () => `sk-gugu-${randomBytes(32).toString('base64url')}`;

/** Sets the priority tier whatever the harness put there (Codex sends `default` when its own Fast is off). */
export function withPriorityTier(raw: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
  let body: unknown;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return raw; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return raw;
  return Buffer.from(JSON.stringify({ ...body, service_tier: 'priority' }));
}

async function start(resolveTarget: TargetResolver): Promise<Forwarder> {
  const token = localKey();
  const sessions = new Map<string, string>();
  const server = createServer((request, response) => {
    void forward(request, response, token, sessions, resolveTarget).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Custom model forwarder did not bind loopback'); }
  server.unref();
  return { server, endpoint: `http://127.0.0.1:${address.port}`, apiKey: token, sessions };
}

/** The process key (no session) or a session key; every key is compared in constant time. */
function caller(supplied: Buffer, token: string, sessions: Map<string, string>): { sessionId?: string } | null {
  const same = (key: string) => { const expected = Buffer.from(key); return supplied.length === expected.length && timingSafeEqual(supplied, expected); };
  if (same(token)) return {};
  for (const [key, sessionId] of sessions) if (same(key)) return { sessionId };
  return null;
}

async function forward(request: IncomingMessage, response: ServerResponse, token: string, sessions: Map<string, string>, resolveTarget: TargetResolver): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const route = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)(.*)$/);
  const [protocolName, routeId, ...unexpected] = (route?.[2] ?? '').split('~');
  const protocol = modelProtocolSchema.safeParse(protocolName);
  const gemini = protocol.success && protocol.data === 'gemini-generate-content';
  const auth = request.headers.authorization ?? request.headers['x-api-key'] ?? request.headers['x-goog-api-key']
    ?? (gemini ? url.searchParams.get('key') : undefined);
  const supplied = typeof auth === 'string' ? Buffer.from(auth.replace(/^Bearer /, '')) : null;
  const from = supplied && caller(supplied, token, sessions);
  if (!from) {
    response.writeHead(401).end();
    return;
  }
  if (!route || !protocol.success || unexpected.length || (routeId !== undefined && !/^[0-9a-f-]{36}$/i.test(routeId))) { response.writeHead(404).end(); return; }
  const target = await resolveTarget(route[1]!, protocol.data, routeId, from.sessionId);
  if (!target) { response.writeHead(404).end(); return; }

  url.searchParams.delete('key');
  const endpoint = target.endpoint.replace(/\/$/, '');
  const suffix = route[3] ?? '';
  // Native Gemini writers supply the version path themselves.
  const path = gemini && endpoint.endsWith('/v1beta') && suffix.startsWith('/v1beta/')
    ? suffix.slice('/v1beta'.length) : suffix;
  await proxyPlatformCredentialRequest(request, response, {
    upstream: () => new URL(`${endpoint}${path}${url.search}`),
    localOnlyHeaders: new Set(['x-goog-api-key', 'x-gugu-actor-authorization']),
    credential: async () => target.apiKey,
    credentialHeaders: (key): Record<string, string> => gemini ? { 'x-goog-api-key': key }
      : protocol.data === 'anthropic-messages' ? { authorization: `Bearer ${key}`, 'x-api-key': key }
        : { authorization: `Bearer ${key}` },
    maxRequestBytes: 50 * 1024 * 1024,
    ...(target.priority ? { body: withPriorityTier } : {}),
    warn: () => {}, // The caller receives the transport failure without logging provider data.
  });
}

/** The port and local token live as long as the app's generated provider catalog. */
export function releaseCustomModelForwarders(): void {
  const started = pending;
  pending = undefined;
  void started?.then(({ server }) => { server.closeAllConnections(); server.close(); }, () => {});
}
