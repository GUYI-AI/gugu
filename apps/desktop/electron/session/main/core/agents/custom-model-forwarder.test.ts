import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { customModelForwarder, customModelRoute, releaseCustomModelForwarders } from './custom-model-forwarder';
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

it('strips thinking settings only on the route created for the explicit turn-off', async () => {
  const endpoint = await upstream(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.end(Buffer.concat(chunks));
  });
  const local = await customModelForwarder(async () => ({ endpoint, apiKey: 'provider-key' }));
  const regular = customModelRoute(local.endpoint, 'record', 'openai-responses');
  const disabled = customModelRoute(local.endpoint, 'record', 'openai-responses', undefined, true);
  const request = { model: 'm', reasoning: { effort: 'medium' }, input: 'The original prompt', stream: true };
  const post = (address: string) => fetch(address + '/responses', {
    method: 'POST', headers: { authorization: `Bearer ${local.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(request),
  }).then(response => response.json());
  const [unchanged, stripped] = await Promise.all([post(regular), post(disabled)]);
  expect(unchanged).toEqual(request);
  expect(stripped).toEqual({ model: 'm', input: 'The original prompt', stream: true });
});
