import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { customModelForwarder, customModelRoute, customModelSessionKey, releaseCustomModelForwarders, withPriorityTier } from './custom-model-forwarder';
const upstreams: Server[] = [];
afterEach(async () => { releaseCustomModelForwarders(); await Promise.all(upstreams.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function upstream(handler: RequestListener) {
  const server = createServer(handler); upstreams.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it('authenticates the process-local token and keeps independent record routes', async () => {
  let auth: string | undefined, body = '', path = '';
  const bytes = 'event: message\ndata: {"tool":{"name":"Bash","input":"echo hello"}}\n\ndata: [DONE]\n\n';
  const endpoint = await upstream(async (request, response) => {
    auth = request.headers.authorization; path = request.url!;
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(bytes.slice(0, 25)); response.end(bytes.slice(25));
  });
  const resolve = async (id: string) => id === 'a' ? { endpoint: endpoint + '/v1', apiKey: 'provider-secret' }
    : id === 'b' ? { endpoint: endpoint + '/other', apiKey: 'other-secret' } : null;
  const local = await customModelForwarder(resolve);
  expect(await customModelForwarder(resolve)).toEqual(local);
  expect(JSON.stringify(local)).not.toContain('provider-secret');
  const a = customModelRoute(local.endpoint, 'a', 'openai-responses');
  const b = customModelRoute(local.endpoint, 'b', 'openai-responses');
  const missing = customModelRoute(local.endpoint, 'missing', 'openai-responses');
  const headers = { authorization: `Bearer ${local.apiKey}`, 'content-type': 'application/json' };
  expect((await fetch(a + '/responses', { headers: { authorization: 'Bearer incorrect' } })).status).toBe(401);
  expect((await fetch(missing + '/responses', { headers })).status).toBe(404);
  const response = await fetch(a + '/responses', { method: 'POST', headers, body: '{"model":"m","stream":true}' });
  expect(await response.text()).toBe(bytes); expect(auth).toBe('Bearer provider-secret'); expect(path).toBe('/v1/responses'); expect(body).toBe('{"model":"m","stream":true}');
  const other = await fetch(b + '/responses', { method: 'POST', headers, body: '{"model":"m"}' });
  expect(await other.text()).toBe(bytes); expect(auth).toBe('Bearer other-secret'); expect(path).toBe('/other/responses');
  releaseCustomModelForwarders(); await Promise.resolve();
  await expect(fetch(a + '/responses')).rejects.toThrow();
});
it.each(['anthropic-messages', 'gemini-generate-content'] as const)('%s substitutes its provider header and never forwards local query authentication', async (protocol) => {
  let seen: Record<string, unknown> = {};
  const endpoint = await upstream((request, response) => { seen = { headers: request.headers, path: request.url }; response.writeHead(401); response.end('provider refused'); });
  const local = await customModelForwarder(async () => ({ endpoint, apiKey: 'real-key' }));
  const header = protocol === 'anthropic-messages' ? 'x-api-key' : 'x-goog-api-key';
  const response = await fetch(customModelRoute(local.endpoint, 'record', protocol) + '/v1/messages?key=placeholder', { headers: { [header]: local.apiKey } });
  expect(response.status).toBe(401); expect(await response.text()).toBe('provider refused');
  expect((seen.headers as Record<string, unknown>)[header]).toBe('real-key'); expect(seen.path).toBe('/v1/messages');
});
it('accepts a Gemini local query key and joins a versioned endpoint once', async () => {
  const endpoint = await upstream((request, response) => {
    response.end(JSON.stringify({ path: request.url, key: request.headers['x-goog-api-key'] }));
  });
  const local = await customModelForwarder(async () => ({ endpoint: endpoint + '/prefix/v1beta', apiKey: 'provider-key' }));
  const route = customModelRoute(local.endpoint, 'record', 'gemini-generate-content');
  const response = await fetch(route + '/v1beta/models/m:streamGenerateContent?alt=sse&key=' + local.apiKey);
  expect(await response.json()).toEqual({ path: '/prefix/v1beta/models/m:streamGenerateContent?alt=sse', key: 'provider-key' });
});
it('a session key names its session to the resolver, and a priority target overwrites the tier the harness sent', async () => {
  const bodies: string[] = [];
  const endpoint = await upstream(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    bodies.push(body); response.end('{}');
  });
  const asked: (string | undefined)[] = [];
  const resolve = async (_id: string, _protocol: string, _route?: string, sessionId?: string) => {
    asked.push(sessionId);
    return { endpoint, apiKey: 'provider-key', ...(sessionId === 'fast' ? { priority: true } : {}) };
  };
  const local = await customModelForwarder(resolve);
  const fast = await customModelSessionKey(resolve, 'fast');
  const plain = await customModelSessionKey(resolve, 'plain');
  expect(await customModelSessionKey(resolve, 'fast')).toBe(fast);
  expect(new Set([local.apiKey, fast, plain]).size).toBe(3);
  const route = customModelRoute(local.endpoint, 'record', 'openai-responses') + '/responses';
  const send = (key: string) => fetch(route, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{"model":"m","service_tier":"default"}' });
  for (const key of [fast, plain, local.apiKey]) expect((await send(key)).status).toBe(200);
  expect(asked).toEqual(['fast', 'plain', undefined]);
  expect(bodies.map((body) => JSON.parse(body).service_tier)).toEqual(['priority', 'default', 'default']);
  expect(JSON.parse(bodies[0]!).model).toBe('m');
});
it('leaves a body that is not a JSON object as it was', () => {
  for (const raw of ['not json', '[1,2]', 'null', '']) expect(withPriorityTier(Buffer.from(raw)).toString()).toBe(raw);
  expect(JSON.parse(withPriorityTier(Buffer.from('{"input":"hi"}')).toString())).toEqual({ input: 'hi', service_tier: 'priority' });
});
