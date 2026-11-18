import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { modelProtocolSchema, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import { proxyPlatformCredentialRequest } from '../../../../sessionpage/platform-credential-proxy';

type Target = { endpoint: string; apiKey: string };
type TargetResolver = (connectionId: string, protocol: ModelProtocol) => Promise<Target | null>;
type Forwarder = { server: Server; endpoint: string; apiKey: string };
let pending: Promise<Forwarder> | undefined;

/** One address per stored endpoint for the life of this app process. */
export function customModelRoute(root: string, connectionId: string, protocol: ModelProtocol): string {
  return `${root}/r/${connectionId}/${protocol}`;
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

async function start(resolveTarget: TargetResolver): Promise<Forwarder> {
  const token = `sk-gugu-${randomBytes(32).toString('base64url')}`;
  const server = createServer((request, response) => {
    void forward(request, response, token, resolveTarget).catch(() => {
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
  return { server, endpoint: `http://127.0.0.1:${address.port}`, apiKey: token };
}

async function forward(request: IncomingMessage, response: ServerResponse, token: string, resolveTarget: TargetResolver): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const route = url.pathname.match(/^\/r\/([^/]+)\/([^/]+)(.*)$/);
  const protocol = modelProtocolSchema.safeParse(route?.[2]);
  const gemini = protocol.success && protocol.data === 'gemini-generate-content';
  const auth = request.headers.authorization ?? request.headers['x-api-key'] ?? request.headers['x-goog-api-key']
    ?? (gemini ? url.searchParams.get('key') : undefined);
  const supplied = typeof auth === 'string' ? Buffer.from(auth.replace(/^Bearer /, '')) : null;
  const expected = Buffer.from(token);
  if (!supplied || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    response.writeHead(401).end();
    return;
  }
  if (!route || !protocol.success) { response.writeHead(404).end(); return; }
  const target = await resolveTarget(route[1]!, protocol.data);
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
    warn: () => {}, // The caller receives the transport failure without logging provider data.
  });
}

/** The port and local token live as long as the app's generated provider catalog. */
export function releaseCustomModelForwarders(): void {
  const started = pending;
  pending = undefined;
  void started?.then(({ server }) => { server.closeAllConnections(); server.close(); }, () => {});
}
