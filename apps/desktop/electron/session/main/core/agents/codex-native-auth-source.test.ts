import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CODEX_NATIVE_AUTH_ENDPOINT, requestNativeCodexAccess } from '@gugu/core/local/codex-native-auth.mjs';

const state = vi.hoisted(() => ({ home: '', run: vi.fn(), cli: vi.fn(async () => '/fixture/selected-official-codex') }));
vi.mock('@gugu/session-plugins/agents/codex-auth', () => ({ withCodexAppServer: state.run }));
vi.mock('@main/core/acp/transport/local-acp-process-host', () => ({ resolveLocalAgentCli: state.cli }));
let source: typeof import('./codex-native-auth-source');
let native: string;
function auth(seconds = 30, refresh = 'fixture-source-refresh') {
  const jwt = (value: unknown) => `h.${Buffer.from(JSON.stringify(value)).toString('base64url')}.s`;
  return { auth_mode: 'chatgpt', tokens: { account_id: 'workspace', refresh_token: refresh,
    id_token: jwt({ sub: 'person', 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace' } }),
    access_token: jwt({ exp: Math.floor(Date.now() / 1000) + seconds }) } };
}
beforeEach(async () => {
  vi.resetModules(); state.run.mockReset(); state.cli.mockClear();
  state.home = await mkdtemp(join(tmpdir(), 'codex-native-authority-')); native = join(state.home, 'native');
  vi.stubEnv('HOME', join(state.home, 'private-home'));
  await mkdir(native); await writeFile(join(native, 'auth.json'), JSON.stringify(auth()));
  source = await import('./codex-native-auth-source');
});
afterEach(async () => { await source.releaseNativeCodexAuthSources(); vi.unstubAllEnvs(); await rm(state.home, { recursive: true, force: true }); });

it('status is a read-only access projection, and Gugu never calls an OAuth endpoint', async () => {
  const before = await readFile(join(native, 'auth.json'));
  const env = await source.nativeCodexAuthEnvironment(native, {});
  const access = await requestNativeCodexAccess(env!);
  expect(access?.chatgptAccountId).toBe('workspace');
  expect(JSON.stringify(access)).not.toContain('fixture-source-refresh');
  expect(state.run).not.toHaveBeenCalled(); expect(state.cli).not.toHaveBeenCalled();
  expect(await readFile(join(native, 'auth.json'))).toEqual(before);
  const forbidden = await fetch(env![CODEX_NATIVE_AUTH_ENDPOINT], { method: 'POST', headers: { origin: 'https://untrusted.invalid' }, body: '{}' });
  expect(forbidden.status).toBe(401);
});

it('renews only through the selected official CLI, in the native root, and coalesces consumers', async () => {
  const writes: string[] = [];
  state.run.mockImplementation(async (ctx, work, options) => {
    expect(ctx.cli).toBe('/fixture/selected-official-codex');
    expect(ctx.env.CODEX_HOME).toBe(await import('node:fs/promises').then(fs => fs.realpath(native)));
    expect(ctx.env.GUGU_CODEX_BIN).toBeUndefined();
    expect(ctx.env.OPENAI_API_KEY).toBeUndefined();
    await options.processObserver.beforeSpawn(); await options.processObserver.spawned(process.pid);
    try { return await work({ request: async (method: string, params: unknown) => {
      expect(method).toBe('account/read'); expect(params).toEqual({ refreshToken: true });
      writes.push('official CLI'); await writeFile(join(native, 'auth.json'), JSON.stringify(auth(3600, 'rotated-only-by-cli')));
      return { account: { type: 'chatgpt' } };
    } }); } finally { await options.processObserver.closed(); }
  });
  const env = await source.nativeCodexAuthEnvironment(native, { OPENAI_API_KEY: 'not-selected', GUGU_CODEX_BIN: '/wrong/adapter' });
  const seen: string[] = []; const original = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(String(input)); seen.push(url.host);
    if (url.hostname !== '127.0.0.1') throw new Error('Gugu must not send a refresh HTTP request');
    return original(input, init);
  });
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => requestNativeCodexAccess(env!, { useToken: true })));
    expect(new Set(results.map(value => value!.accessToken)).size).toBe(1);
    expect(state.run).toHaveBeenCalledTimes(1); expect(writes).toEqual(['official CLI']);
    expect(seen).toHaveLength(4);
    expect(JSON.stringify(results)).not.toContain('rotated-only-by-cli');
  } finally { spy.mockRestore(); }
});

it('an external CLI update before token use avoids starting any renewal process', async () => {
  const env = await source.nativeCodexAuthEnvironment(native, {});
  await writeFile(join(native, 'auth.json'), JSON.stringify(auth(3600)));
  await requestNativeCodexAccess(env!, { useToken: true });
  expect(state.run).not.toHaveBeenCalled();
});

it('keeps native API-key mode usable after OAuth, without exporting inactive refresh tokens', async () => {
  await source.nativeCodexAuthEnvironment(native, {});
  const mixed = { ...auth(), auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-active-key' };
  await writeFile(join(native, 'auth.json'), JSON.stringify(mixed));
  const env = await source.nativeCodexAuthEnvironment(native, {});
  expect(env).toEqual({ OPENAI_API_KEY: 'fixture-active-key' });
  expect(JSON.stringify(env)).not.toContain('fixture-source-refresh');
  expect(state.run).not.toHaveBeenCalled();
});

it('revocation remains invalid despite the auth file, and a new native login recovers', async () => {
  state.run.mockRejectedValue(new Error('refresh token was revoked (fixture)'));
  const env = await source.nativeCodexAuthEnvironment(native, {});
  await expect(requestNativeCodexAccess(env!, { useToken: true })).rejects.toThrow('登录被另一个客户端顶掉');
  await expect(requestNativeCodexAccess(env!)).rejects.toThrow('codex login');
  expect(state.run).toHaveBeenCalledTimes(1);
  await writeFile(join(native, 'auth.json'), JSON.stringify(auth(3600)));
  expect(await requestNativeCodexAccess(env!)).not.toBeNull();
});

it('shutdown joins the renewal process before completing credential-service cleanup', async () => {
  let entered!: () => void; let closed = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  state.run.mockImplementation(async (_ctx, _work, options) => {
    await options.processObserver.beforeSpawn(); await options.processObserver.spawned(process.pid); entered();
    try { await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); }
    finally { await options.processObserver.closed(); closed = true; }
  });
  const env = await source.nativeCodexAuthEnvironment(native, {});
  const pending = requestNativeCodexAccess(env!, { useToken: true });
  void pending.catch(() => undefined);
  await started;
  expect(closed).toBe(false);
  await source.releaseNativeCodexAuthSources();
  expect(closed).toBe(true);
  await expect(pending).rejects.toThrow();
});
