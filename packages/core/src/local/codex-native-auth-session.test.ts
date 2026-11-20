import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { CODEX_NATIVE_AUTH_BEARER, CODEX_NATIVE_AUTH_ENDPOINT, CODEX_NATIVE_AUTH_ROOT,
  codexAccessProjection, initializeNativeCodexSession, nativeCodexSessionArgs } from './codex-native-auth.mjs';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
function projection(token = 'fixture-access-one') {
  const id = Buffer.from(JSON.stringify({ sub: 'person', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace' } })).toString('base64url');
  return codexAccessProjection({ auth_mode: 'chatgpt', tokens: { id_token: `h.${id}.s`, access_token: token,
    account_id: 'workspace', refresh_token: 'never-leave-native-file' } });
}
async function authority() {
  let view = projection();
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe('Bearer fixture-local-route');
    let text = ''; for await (const part of request) text += part.toString();
    requests.push(JSON.parse(text)); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(view));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
  const address = server.address() as { port: number };
  return { env: { [CODEX_NATIVE_AUTH_ENDPOINT]: `http://127.0.0.1:${address.port}/native/fixture`,
    [CODEX_NATIVE_AUTH_BEARER]: 'fixture-local-route', [CODEX_NATIVE_AUTH_ROOT]: '/synthetic/native' }, requests,
    update: (token: string) => { view = projection(token); } };
}

it('installs access-only ephemeral auth and a callback before the login RPC', async () => {
  const a = await authority(); let callback: unknown;
  const rpc = vi.fn(async (method: string, params: unknown) => {
    expect(callback).toBeTypeOf('function'); expect(method).toBe('account/login/start');
    expect(params).toEqual({ type: 'chatgptAuthTokens', accessToken: 'fixture-access-one', chatgptAccountId: 'workspace' });
    expect(JSON.stringify(params)).not.toContain('never-leave-native-file');
  });
  await initializeNativeCodexSession(a.env, rpc, { setRefresh: value => { callback = value; } });
  expect(nativeCodexSessionArgs(a.env)).toEqual(['-c', 'cli_auth_credentials_store="ephemeral"']);
  expect(a.requests).toEqual([{ useToken: true }]);
});

it('rereads on actual message delivery; an external update replaces access auth without an OAuth HTTP request', async () => {
  const a = await authority(); const rpc = vi.fn(async () => undefined);
  const session = await initializeNativeCodexSession(a.env, rpc);
  await session!.ensure(); expect(rpc).toHaveBeenCalledTimes(1);
  a.update('externally-updated-access'); await session!.ensure();
  expect(rpc).toHaveBeenLastCalledWith('account/login/start', { type: 'chatgptAuthTokens', accessToken: 'externally-updated-access', chatgptAccountId: 'workspace' });
  expect(a.requests).toEqual([{ useToken: true }, { useToken: true }, { useToken: true }]);
});

it('401 callback uses the current generation and refuses unchanged credentials or another workspace', async () => {
  const a = await authority(); const session = await initializeNativeCodexSession(a.env, async () => undefined);
  await expect(session!.refresh({ previousAccountId: 'different' })).rejects.toThrow('workspace changed');
  expect(a.requests).toHaveLength(1);
  await expect(session!.refresh({ previousAccountId: 'workspace' })).rejects.toThrow('needs recovery');
  expect(a.requests[1]).toEqual({ useToken: true, unauthorizedToken: 'fixture-access-one' });
  a.update('externally-updated-access');
  expect(await session!.refresh({ previousAccountId: 'workspace' })).toEqual({ accessToken: 'externally-updated-access', chatgptAccountId: 'workspace' });
});

it('platform routes do not contact the native authority or replace provider credentials', async () => {
  const a = await authority(); const rpc = vi.fn();
  expect(await initializeNativeCodexSession(a.env, rpc, { platform: true })).toBeNull();
  expect(a.requests).toEqual([]); expect(rpc).not.toHaveBeenCalled();
});

it('a missing native login fails before loading a stale managed OAuth file', async () => {
  const rpc = vi.fn();
  await expect(initializeNativeCodexSession({ [CODEX_NATIVE_AUTH_ROOT]: '/missing/native' }, rpc)).rejects.toThrow('codex login');
  expect(rpc).not.toHaveBeenCalled();
});
