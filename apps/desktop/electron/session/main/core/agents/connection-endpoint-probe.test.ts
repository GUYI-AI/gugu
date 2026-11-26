import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { getGlobalDispatcher } from 'undici';
import { connectionModelListSchema, customModelProtocolProbeSchema } from '@gugu/session-core/workspace-server/agent-config';
import { detectModelProtocol } from '@gugu/session-core/models/custom-model';
import { listEndpointModels, probeEndpointProtocols, verifyEndpointModel } from './connection-endpoint-probe';

const target = { endpoint: 'https://provider.test/v1', apiKey: 'dummy-key', protocol: 'openai-chat-completions' as const, env: {} };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const failingFetch = (error: unknown): typeof fetch => vi.fn(async () => { throw error; });

it.each([
  ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['ECONNREFUSED', 'connection-refused'],
  ['ETIMEDOUT', 'timeout'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['UND_ERR_HEADERS_TIMEOUT', 'timeout'], ['UND_ERR_BODY_TIMEOUT', 'timeout'],
  ['CERT_HAS_EXPIRED', 'certificate'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'certificate'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate'], ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'certificate'],
] as const)('preserves nested %s as %s across list, named-model and protocol probing', async (code, reason) => {
  const error = new TypeError('private upstream text: dummy-key', { cause: new Error('private host', { cause: Object.assign(new Error('private cause'), { code }) }) });
  const fetcher = failingFetch(error);
  expect(connectionModelListSchema.parse(await listEndpointModels(target, fetcher))).toEqual({ kind: 'unlisted', reason });
  expect(await verifyEndpointModel(target, 'model', fetcher)).toEqual({ kind: 'unlisted', reason });
  const result = await probeEndpointProtocols({ baseUrl: target.endpoint, apiKey: target.apiKey, env: {}, modelId: 'model' }, fetcher);
  expect(customModelProtocolProbeSchema.parse(result)).toEqual(result);
  expect(result.failures).toHaveLength(5);
  expect(result.failures.every((failure) => failure.reason === reason)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private|dummy-key|ENOTFOUND/);
});

it('uses structured causes and aggregate errors, never guesses from error text', async () => {
  const error = new AggregateError([Object.assign(new Error('hidden'), { code: 'ECONNREFUSED' })], 'hidden');
  expect(await listEndpointModels(target, failingFetch(error))).toEqual({ kind: 'unlisted', reason: 'connection-refused' });
  const cyclic = new Error('ENOTFOUND ECONNREFUSED certificate timed out dummy-key');
  cyclic.cause = cyclic;
  expect(await listEndpointModels(target, failingFetch(cyclic))).toEqual({ kind: 'unlisted', reason: 'unreachable' });
});

it('classifies the actual deadline abort reason even if fetch rejects without a code', async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const fetcher: typeof fetch = vi.fn(async (_url, init) => {
    const pending = new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new TypeError('fetch failed')), { once: true }));
    controller.abort(new DOMException('private deadline detail', 'TimeoutError'));
    return pending;
  });
  expect(await listEndpointModels(target, fetcher)).toEqual({ kind: 'unlisted', reason: 'timeout' });
  expect(timeout).toHaveBeenCalledWith(10_000);
});

it('keeps body transport failures distinct from malformed model-list JSON', async () => {
  const response = new Response();
  vi.spyOn(response, 'json').mockRejectedValue(new TypeError('hidden body error', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } }));
  expect(await listEndpointModels(target, vi.fn(async () => response))).toEqual({ kind: 'unlisted', reason: 'timeout' });
  expect(await listEndpointModels(target, vi.fn(async () => new Response('not json')))).toEqual({ kind: 'unlisted', reason: 'no-list' });
});

it.each([401, 403, 404])('keeps HTTP %s separate from transport failures', async (status) => {
  expect(await listEndpointModels(target, vi.fn(async () => new Response('private provider response', { status })))).toEqual({ kind: 'unlisted', reason: status === 404 ? 'no-list' : 'unauthorized' });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

const PROXIED_ORIGIN = 'origin.test';

async function origin(status = 200) {
  const requests: { url: string; key?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', key: req.headers.authorization });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
  });
  const url = await listen(server);
  // Loopback always goes direct through the egress; the proxy tests ask for this name, which only the test proxy knows.
  return { url, named: url.replace('127.0.0.1', PROXIED_ORIGIN), requests };
}

async function proxy() {
  const tunnels: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => { res.writeHead(500); res.end(); });
  server.on('connect', (req, client, head) => {
    tunnels.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    // This test proxy must never open a non-loopback connection.
    if (host !== PROXIED_ORIGIN) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const upstream = connect(Number(port), '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket as Socket);
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
      socket.on('close', () => sockets.delete(socket as Socket));
    }
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  const url = await listen(server);
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); });
  return { url, tunnels };
}

it.each(['HTTP_PROXY', 'http_proxy', 'ALL_PROXY'] as const)('uses %s for real requests without changing global fetch or its dispatcher', async (name) => {
  const upstream = await origin();
  const gateway = await proxy();
  const dispatcher = getGlobalDispatcher();
  const originalFetch = globalThis.fetch;
  const env = { [name]: gateway.url };
  expect(await listEndpointModels({ ...target, endpoint: upstream.named, env })).toEqual({ kind: 'listed', models: ['local-model'] });
  expect(gateway.tunnels).toEqual([new URL(upstream.named).host]);
  expect(upstream.requests).toEqual([{ url: '/models', key: 'Bearer dummy-key' }]);
  expect(env).toEqual({ [name]: gateway.url });
  expect(getGlobalDispatcher()).toBe(dispatcher);
  expect(globalThis.fetch).toBe(originalFetch);
});

it('uses HTTPS_PROXY for an HTTPS destination instead of attempting DNS/direct access', async () => {
  const gateway = await proxy();
  expect(await listEndpointModels({ ...target, env: { HTTPS_PROXY: gateway.url } })).toEqual({ kind: 'unlisted', reason: 'proxy' });
  expect(gateway.tunnels).toEqual(['provider.test:443']);
});

it('fails at the configured proxy when old global fetch would silently reach a live origin', async () => {
  const upstream = await origin(401);
  const server = createServer();
  const badProxy = await listen(server);
  await cleanups.pop()?.(); // Keep a known closed local port; no external connection or timeout.
  vi.stubEnv('HTTP_PROXY', badProxy);
  vi.stubEnv('http_proxy', badProxy);
  vi.stubEnv('NODE_USE_ENV_PROXY', '');
  const direct = await fetch(upstream.url);
  expect(direct.status).toBe(401); // Negative control: the old fetch ignores this env.
  await direct.body?.cancel();
  expect(upstream.requests).toHaveLength(1);
  expect(await listEndpointModels({ ...target, endpoint: upstream.named, env: { HTTP_PROXY: badProxy } })).toEqual({ kind: 'unlisted', reason: 'connection-refused' });
  expect(upstream.requests).toHaveLength(1); // No silent direct fallback or credential delivery.
  expect(await listEndpointModels({ ...target, env: { HTTPS_PROXY: badProxy } })).toEqual({ kind: 'unlisted', reason: 'connection-refused' });
});

it('obeys NO_PROXY and lowercase precedence, and does not borrow ambient proxy values', async () => {
  const upstream = await origin();
  const gateway = await proxy();
  vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
  vi.stubEnv('NO_PROXY', '*');
  expect(await listEndpointModels({ ...target, endpoint: upstream.named, env: { http_proxy: gateway.url, HTTP_PROXY: 'http://127.0.0.1:1', no_proxy: '', NO_PROXY: '*' } })).toMatchObject({ kind: 'listed' });
  expect(gateway.tunnels).toHaveLength(1);
  // Bypassed or unset, the request goes direct: the name does not resolve, and neither the gateway nor the ambient
  // (refusing) proxy sees it.
  expect(await listEndpointModels({ ...target, endpoint: upstream.named, env: { HTTP_PROXY: gateway.url, NO_PROXY: PROXIED_ORIGIN } })).toEqual({ kind: 'unlisted', reason: 'dns' });
  expect(gateway.tunnels).toHaveLength(1);
  expect(await listEndpointModels({ ...target, endpoint: upstream.named, env: {} })).toEqual({ kind: 'unlisted', reason: 'dns' });
  expect(upstream.requests).toHaveLength(1);
});

it.each(['ftp://127.0.0.1:1', 'not a proxy URL'])('refuses unsupported proxy %s without falling back to direct access', async (value) => {
  const upstream = await origin();
  expect(await listEndpointModels({ ...target, endpoint: upstream.named, env: { ALL_PROXY: value } })).toEqual({ kind: 'unlisted', reason: 'proxy' });
  expect(upstream.requests).toHaveLength(0);
});

it('reports a real redirect without following it or forwarding its key', async () => {
  const destination = await origin();
  const server = createServer((_req, res) => { res.writeHead(302, { location: destination.url }); res.end(); });
  const url = await listen(server);
  expect(await listEndpointModels({ ...target, endpoint: url })).toEqual({ kind: 'unlisted', reason: 'redirect' });
  expect(await verifyEndpointModel({ ...target, endpoint: url }, 'model')).toEqual({ kind: 'unlisted', reason: 'redirect' });
  expect(destination.requests).toHaveLength(0);
});

// What real providers answer a fake key (d22, 2026-11-26): most check the key before routing (DeepSeek, OpenRouter, Zhipu and
// Anthropic answer 401 on every path); OpenAI, Kimi, MiniMax and DashScope answer 404 on /messages, SiliconFlow on /responses.
const byPath = (statuses: Record<string, number>): typeof fetch => vi.fn(async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new Response('{}', { status: statuses[new URL(url).pathname] ?? 404 });
});
it('records the paths that refused the key, in the order tried, so a refused address is added as one that exists', async () => {
  const result = await probeEndpointProtocols({ baseUrl: 'https://relay.test', apiKey: 'dummy-key', env: {}, modelId: 'model' }, byPath({
    '/v1/models': 401, '/models': 401, '/v1/messages': 401, '/v1/chat/completions': 404, '/v1/responses': 404,
  }));
  expect(customModelProtocolProbeSchema.parse(result)).toEqual(result);
  expect(result.endpoints).toEqual([]);
  expect(result.refused).toEqual([{ protocol: 'anthropic-messages', baseUrl: 'https://relay.test' }]);
  expect(result.failures).toContainEqual({ step: 'anthropic-messages', reason: 'unauthorized' });
});
it('a 401 under /v1 is kept when the bare address then answers 404, and an address that refuses every path lists OpenAI Chat first', async () => {
  const result = await probeEndpointProtocols({ baseUrl: 'https://relay.test', apiKey: 'dummy-key', env: {}, modelId: 'model' }, byPath({
    '/v1/chat/completions': 401, '/v1/responses': 401, '/messages': 401, '/v1/messages': 401, '/v1beta/models/model:generateContent': 401,
  }));
  expect(result.refused?.[0]).toEqual({ protocol: 'openai-chat-completions', baseUrl: 'https://relay.test/v1' });
  expect(result.failures).toContainEqual({ step: 'openai-chat-completions', reason: 'unauthorized' });
  const none = await probeEndpointProtocols({ baseUrl: 'https://relay.test/v1', apiKey: 'dummy-key', env: {}, modelId: 'model' }, byPath({ '/v1/models': 401 }));
  expect(none.refused).toBeUndefined();
});
// Anthropic's own API and Zhipu's Anthropic route answer 401 on every path with a refused key (measured above): only the
// address can tell, and it does, so these are added anyway as Anthropic, not as OpenAI Chat that their first session would fail on.
it.each([
  ['https://api.anthropic.com', { protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }],
  ['https://open.bigmodel.cn/api/anthropic', { protocol: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' }],
] as const)('%s, refusing the key on every path, is added anyway as Anthropic', async (baseUrl, first) => {
  const everywhere: typeof fetch = vi.fn(async () => new Response('{}', { status: 401 }));
  const result = await probeEndpointProtocols({ baseUrl, apiKey: 'dummy-key', env: {}, modelId: 'model', hint: detectModelProtocol(baseUrl) }, everywhere);
  expect(result.refused?.[0]).toEqual(first);
});
