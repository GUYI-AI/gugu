import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { withCodexAppServer } from '@gugu/session-plugins/agents/codex-auth';
import {
  CODEX_NATIVE_AUTH_BEARER, CODEX_NATIVE_AUTH_ENDPOINT, CODEX_NATIVE_AUTH_ROOT,
  codexOAuthIdentity, createCodexNativeAuthAuthority, refreshNativeCodexThroughCli,
  type CodexNativeAccessRequest,
} from '@gugu/core/local/codex-native-auth.mjs';
import { assertCodexFileCredentialStore } from './codex-auth-slot';
import { CODEX_CONNECTION_UNSET_ENV } from './harness-connection-launch';
import { withCodexNativeAuthLease, type CodexAuthProcessObserver } from './codex-native-auth-lease';

/** Only file-backed authority is in scope. Never treat a stale fallback as the active keyring login. */
export async function readNativeCodexOAuth(root: string): Promise<Record<string, unknown> | null> {
  await assertCodexFileCredentialStore(root);
  let raw: string;
  try { raw = await readFile(join(root, 'auth.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Codex native sign-in file is invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Codex native sign-in file is invalid');
  return value as Record<string, unknown>;
}

type Route = {
  bearer: string;
  read: ReturnType<typeof createCodexNativeAuthAuthority>;
  context: { env: Record<string, string> };
};
const routes = new Map<string, Route>();
let listener: Promise<{ server: Server; endpoint: string }> | undefined;
const refreshing = new Map<AbortController, Promise<unknown>>();
let stopping = false;

function endpoint(): Promise<{ server: Server; endpoint: string }> {
  if (stopping) throw new Error('Native Codex credential service is stopping');
  if (listener) return listener;
  const started = (async () => {
    const server = createServer((request, response) => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', 'application/json');
      void (async () => {
        const id = (request.url ?? '').match(/^\/native\/([a-f0-9]{64})$/)?.[1];
        const route = id ? routes.get(id) : undefined;
        const provided = Buffer.from(request.headers.authorization ?? '');
        const wanted = Buffer.from(`Bearer ${route?.bearer ?? ''}`);
        if (!route || request.method !== 'POST' || request.headers.origin || provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
          response.writeHead(401).end('{}'); return;
        }
        let body = '';
        for await (const part of request) {
          body += part.toString();
          if (Buffer.byteLength(body) > 32_768) { response.writeHead(413).end('{}'); return; }
        }
        let options: CodexNativeAccessRequest;
        try {
          options = JSON.parse(body) as CodexNativeAccessRequest;
          if (!options || typeof options !== 'object' || Array.isArray(options)
            || options.useToken !== undefined && typeof options.useToken !== 'boolean'
            || options.unauthorizedToken !== undefined && typeof options.unauthorizedToken !== 'string') throw new Error();
        } catch { response.writeHead(400).end('{}'); return; }
        const access = await route.read(options);
        response.end(JSON.stringify(access));
      })().catch(error => {
        // Neither the source document nor CLI stderr goes to an HTTP error/log/renderer.
        const revoked = /refresh token.*(?:revoked|reused)|refresh_token_(?:revoked|reused)/i.test(error instanceof Error ? error.message : '');
        if (!response.headersSent) response.writeHead(503);
        response.end(JSON.stringify({ reason: revoked ? 'revoked' : 'unavailable' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error('Native Codex credential service did not bind loopback'); }
    server.unref();
    return { server, endpoint: `http://127.0.0.1:${address.port}` };
  })();
  listener = started;
  void started.catch(() => { if (listener === started) listener = undefined; });
  return started;
}

/** Register a path/identity reference, not a copy of OAuth credentials. No refresh happens here. */
export async function nativeCodexAuthEnvironment(root: string, userEnv: Record<string, string>): Promise<Record<string, string> | null> {
  const auth = await readNativeCodexOAuth(root);
  const identity = codexOAuthIdentity(auth);
  if (!identity) return null;
  const source = await realpath(root);
  const id = createHash('sha256').update(source).update('\0').update(identity).digest('hex');
  const env: Record<string, string> = { ...userEnv, CODEX_HOME: source };
  for (const name of [...CODEX_CONNECTION_UNSET_ENV, CODEX_NATIVE_AUTH_ENDPOINT, CODEX_NATIVE_AUTH_BEARER, CODEX_NATIVE_AUTH_ROOT]) delete env[name];
  delete env.GUGU_CODEX_BIN; // The selected official CLI, never a session adapter override.
  let route = routes.get(id);
  if (route) route.context.env = env;
  if (!route) {
    // All profiles under this user's application-data parent share source admission.
    const lockRoot = join(dirname(app.getPath('userData')), 'gugu-codex-native-auth-operations');
    const context = { env };
    let admitted: CodexAuthProcessObserver | undefined;
    const coordinated = createCodexNativeAuthAuthority({
      identity, read: () => readNativeCodexOAuth(source),
      serialize: async work => {
        const credential = await realpath(join(source, 'auth.json'));
        return withCodexNativeAuthLease(lockRoot, credential, async observer => {
          if (await realpath(join(source, 'auth.json')) !== credential) throw new Error('Native Codex credential authority changed while waiting');
          admitted = observer;
          try { return await work(); } finally { admitted = undefined; }
        });
      },
      refresh: async ({ accessToken }) => {
        if (!admitted) throw new Error('Native Codex refresh has no process admission');
        const { resolveLocalAgentCli } = await import('@main/core/acp/transport/local-acp-process-host');
        const cli = await resolveLocalAgentCli('codex', 'primary');
        let revoked = false;
        let failed = false;
        if (stopping) throw new Error('Native Codex credential service is stopping');
        const controller = new AbortController();
        const work = refreshNativeCodexThroughCli(callback => withCodexAppServer({ cli, env: context.env }, async server => {
          if (revoked) throw new Error('Codex refresh token was revoked; run codex login');
          if (failed) throw new Error('Codex could not renew its native sign-in; retry when the connection recovers');
          return callback(server);
        }, { processObserver: admitted, requestTimeoutMs: 60_000, onAuthRevoked: () => { revoked = true; },
          onAuthRefreshFailure: () => { failed = true; }, signal: controller.signal }),
        { read: () => readNativeCodexOAuth(source), identity, accessToken });
        refreshing.set(controller, work);
        try { await work; } finally { refreshing.delete(controller); }
        if (revoked) throw new Error('Codex refresh token was revoked; run codex login');
      },
    });
    route = { bearer: randomBytes(32).toString('base64url'), read: coordinated, context };
    routes.set(id, route);
  }
  const host = await endpoint();
  return { [CODEX_NATIVE_AUTH_ENDPOINT]: `${host.endpoint}/native/${id}`, [CODEX_NATIVE_AUTH_BEARER]: route.bearer, [CODEX_NATIVE_AUTH_ROOT]: source };
}

export async function releaseNativeCodexAuthSources(): Promise<void> {
  stopping = true;
  for (const controller of refreshing.keys()) controller.abort(new Error('Native Codex credential service is stopping'));
  await Promise.allSettled([...refreshing.values()]);
  const held = listener;
  listener = undefined;
  if (!held) return;
  const { server } = await held;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  routes.clear();
}
