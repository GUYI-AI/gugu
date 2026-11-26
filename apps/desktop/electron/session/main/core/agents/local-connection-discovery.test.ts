import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { redactAll } from '@gugu/session-shared/logger';
import { describeDiscoveryIssues, discoverLocalConnections, discoveredSecret, type DiscoveryIssue, type LocalDiscovery } from './local-connection-discovery';

const OFFICIAL = 'https://api.openai.com/v1';
const KEY = 'sk-live-0123456789abcdefWXYZ';
const OTHER_KEY = 'sk-live-ffffffffffffffffQRST';
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'codex-discovery-')); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

const auth = (value: unknown) => writeFile(join(root, 'auth.json'), JSON.stringify(value));
const config = (text: string) => writeFile(join(root, 'config.toml'), text);
const scan = (env: Record<string, string | undefined> = {}) => discoverLocalConnections({ root, env });
const byName = (found: LocalDiscovery, name: string) => found.connections.find(connection => connection.name === name);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const info = await stat(path);
    out[name] = `${info.mtimeMs}:${info.size}:${info.isFile() ? sha(await readFile(path, 'utf8')) : 'dir'}`;
  }
  return out;
}

it('gives the official key the model Codex runs on it, so no placeholder stands in for one', async () => {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  await config('model = "gpt-5.5"\n[profiles.fast]\nmodel = "gpt-5.5-mini"\n[profiles.other]\nmodel_provider = "relay"\nmodel = "relay-model"\n');
  const [openai] = (await scan()).connections;
  expect(openai!.models).toEqual([{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }]);
});

it('lists the official key kept by Codex as the OpenAI API connection, never its secret', async () => {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  const found = await scan();
  expect(found.issues).toEqual([]);
  expect(found.connections).toHaveLength(1);
  const [openai] = found.connections;
  expect(openai).toMatchObject({ source: 'codex-auth', name: 'OpenAI', preset: 'openai', keyLast4: 'WXYZ', models: [] });
  expect(openai!.endpoints).toEqual(expect.arrayContaining([
    { protocol: 'openai-responses', baseUrl: OFFICIAL }, { protocol: 'openai-chat-completions', baseUrl: OFFICIAL },
  ]));
  expect(openai!.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  expect(discoveredSecret(openai!)).toBe(KEY);
  expect(JSON.stringify(found)).not.toContain(KEY);
  expect(JSON.stringify(found)).not.toContain(KEY.slice(0, 12));
});

it('keeps the same identity for the same key and address, and a different one for a different key', async () => {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  const first = await scan();
  const again = await scan();
  expect(again.connections[0]!.id).toBe(first.connections[0]!.id);
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: OTHER_KEY });
  const rotated = await scan();
  expect(rotated.connections).toHaveLength(1);
  expect(rotated.connections[0]!.id).not.toBe(first.connections[0]!.id);
});

it('follows the official auth mode: an inactive field is never a second connection', async () => {
  await auth({ auth_mode: 'chatgpt', OPENAI_API_KEY: KEY, tokens: { id_token: 'x', access_token: 'y', refresh_token: 'z' } });
  expect((await scan()).connections).toEqual([]);
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY, tokens: { id_token: 'x' } });
  expect((await scan()).connections).toHaveLength(1);
  await auth({ OPENAI_API_KEY: KEY });
  expect((await scan()).connections).toHaveLength(1);
  await auth({ OPENAI_API_KEY: KEY, tokens: { id_token: 'x' } });
  expect((await scan()).connections).toEqual([]);
});

it('merges the same key and address found in the file and the login shell; a different key stays separate', async () => {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  const same = await scan({ OPENAI_API_KEY: KEY });
  expect(same.connections).toHaveLength(1);
  expect(same.connections[0]!.source).toBe('codex-auth');
  const two = await scan({ OPENAI_API_KEY: OTHER_KEY });
  expect(two.connections.map(connection => connection.source).sort()).toEqual(['codex-auth', 'shell-env']);
  expect(new Set(two.connections.map(connection => connection.id)).size).toBe(2);
});

it('tells two connections that would carry the same name apart by their key ending, and leaves unique names alone', async () => {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  await config('[model_providers.acme]\nname = "Acme"\nbase_url = "https://acme.example.test/v1"\nenv_key = "K"\n');
  const found = await scan({ OPENAI_API_KEY: OTHER_KEY, K: KEY });
  expect(found.connections.map(connection => connection.name).sort()).toEqual(['Acme', 'OpenAI (…QRST)', 'OpenAI (…WXYZ)']);
  expect((await scan({ OPENAI_API_KEY: KEY })).connections.map(connection => connection.name)).toEqual(['OpenAI']);
});

it('takes a shell key even when Codex has no file at all', async () => {
  const found = await scan({ OPENAI_API_KEY: KEY });
  expect(found.connections).toMatchObject([{ source: 'shell-env', name: 'OpenAI', preset: 'openai', keyLast4: 'WXYZ' }]);
});

it('treats a key aimed at a non-official address as a custom connection that keeps its address', async () => {
  const found = await scan({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: 'https://relay.example.test/openai/v1' });
  expect(found.connections).toHaveLength(1);
  expect(found.connections[0]).toMatchObject({ preset: null, endpoints: expect.arrayContaining([{ protocol: 'openai-responses', baseUrl: 'https://relay.example.test/openai/v1' }]) });
  expect(found.connections[0]!.endpoints.every(endpoint => endpoint.baseUrl === 'https://relay.example.test/openai/v1')).toBe(true);
  await config('openai_base_url = "https://corp.example.test/v1"\n');
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: OTHER_KEY });
  const configured = await scan();
  expect(configured.connections[0]).toMatchObject({ preset: null });
  expect(configured.connections[0]!.endpoints[0]!.baseUrl).toBe('https://corp.example.test/v1');
});

it('lists every explicitly configured provider with its own address, protocol, model and key from the user environment', async () => {
  await config([
    'model_provider = "acme"', 'model = "acme-large"', '',
    '[model_providers.acme]', 'name = "Acme Gateway"', 'base_url = "https://acme.example.test/v1"', 'env_key = "ACME_API_KEY"', 'wire_api = "responses"', '',
    '[model_providers.legacy]', 'name = "Legacy Chat"', 'base_url = "https://legacy.example.test/api/v1"', 'env_key = "LEGACY_KEY"', 'wire_api = "chat"', '',
    '[profiles.fast]', 'model_provider = "legacy"', 'model = "legacy-mini"', '',
  ].join('\n'));
  const found = await scan({ ACME_API_KEY: KEY, LEGACY_KEY: OTHER_KEY });
  expect(found.issues).toEqual([]);
  expect(byName(found, 'Acme Gateway')).toMatchObject({
    source: 'codex-provider', preset: null, keyLast4: 'WXYZ',
    endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://acme.example.test/v1' }], models: [{ id: 'acme-large' }],
  });
  expect(byName(found, 'Legacy Chat')).toMatchObject({
    endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://legacy.example.test/api/v1' }], models: [{ id: 'legacy-mini' }],
  });
});

it('defaults to the Responses protocol and keeps a literal provider token as that provider key', async () => {
  await config('[model_providers.direct]\nname = "Direct"\nbase_url = "https://direct.example.test/v1"\nexperimental_bearer_token = "tok-direct-1234"\n');
  const found = await scan();
  expect(found.connections).toMatchObject([{ name: 'Direct', endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://direct.example.test/v1' }], keyLast4: '1234' }]);
  expect(discoveredSecret(found.connections[0]!)).toBe('tok-direct-1234');
});

it('merges two providers with the same address and key into one connection and keeps both aliases', async () => {
  await config([
    '[model_providers.one]', 'name = "One"', 'base_url = "https://same.example.test/v1"', 'env_key = "K1"', '',
    '[model_providers.two]', 'name = "Two"', 'base_url = "https://same.example.test/v1"', 'env_key = "K2"', 'wire_api = "chat"', '',
  ].join('\n'));
  const found = await scan({ K1: KEY, K2: KEY });
  expect(found.connections).toHaveLength(1);
  expect(found.connections[0]!.aliases.sort()).toEqual(['one', 'two']);
  expect(found.connections[0]!.endpoints.map(endpoint => endpoint.protocol).sort()).toEqual(['openai-chat-completions', 'openai-responses']);
});

it('keeps the same key at two different addresses as two connections', async () => {
  await config([
    '[model_providers.a]', 'base_url = "https://a.example.test/v1"', 'env_key = "KEY_A"', '',
    '[model_providers.b]', 'base_url = "https://b.example.test/v1"', 'env_key = "KEY_B"', '',
  ].join('\n'));
  const found = await scan({ KEY_A: KEY, KEY_B: KEY });
  expect(found.connections).toHaveLength(2);
});

it('a provider that already points at the official address and key is the official connection, not a second custom one', async () => {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  await config(`[model_providers.mine]\nname = "Mine"\nbase_url = "${OFFICIAL}"\nenv_key = "MINE_KEY"\n`);
  const found = await scan({ MINE_KEY: KEY });
  expect(found.connections).toHaveLength(1);
  expect(found.connections[0]).toMatchObject({ name: 'OpenAI', preset: 'openai' });
});

it('reports a provider whose key variable is missing instead of guessing a key or finding nothing', async () => {
  await config('[model_providers.acme]\nname = "Acme"\nbase_url = "https://acme.example.test/v1"\nenv_key = "ACME_API_KEY"\n');
  const found = await scan({ ACME_API_KEY: '  ' });
  expect(found.connections).toEqual([]);
  expect(found.issues).toEqual([{ code: 'key-missing', where: 'config.toml', provider: 'acme' }]);
});

it('never rewrites an address the generic connection cannot hold: query, route suffix and request customisation are reported', async () => {
  await config([
    '[model_providers.query]', 'base_url = "https://q.example.test/v1?api-version=1"', 'env_key = "K"', '',
    '[model_providers.suffix]', 'base_url = "https://s.example.test/v1/responses"', 'env_key = "K"', '',
    '[model_providers.params]', 'base_url = "https://p.example.test/v1"', 'env_key = "K"', 'query_params = { "api-version" = "1" }', '',
    '[model_providers.headers]', 'base_url = "https://h.example.test/v1"', 'env_key = "K"', 'env_http_headers = { "api-key" = "K" }', '',
    '[model_providers.plain]', 'base_url = "https://ok.example.test/v1/"', 'env_key = "K"', '',
  ].join('\n'));
  const found = await scan({ K: KEY });
  expect(found.issues.map(issue => `${issue.code}:${issue.provider}`).sort()).toEqual([
    'incompatible:headers', 'incompatible:params', 'incompatible:query', 'incompatible:suffix',
  ]);
  expect(found.connections).toHaveLength(1);
  expect(found.connections[0]!.endpoints[0]!.baseUrl).toBe('https://ok.example.test/v1');
});

it('skips providers that use the OpenAI sign-in and the built-in OpenAI provider override', async () => {
  await config('[model_providers.oauthish]\nname = "ChatGPT via proxy"\nbase_url = "https://x.example.test/v1"\nrequires_openai_auth = true\n');
  expect((await scan({})).connections).toEqual([]);
});

it('a broken config.toml is an issue, while the auth file and the login shell are still read', async () => {
  await config('this is = = not toml');
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  const found = await scan({ OPENAI_API_KEY: OTHER_KEY });
  expect(found.issues).toEqual([{ code: 'invalid-config', where: 'config.toml' }]);
  expect(found.connections).toHaveLength(2);
});

it('a broken auth.json is an issue and does not hide providers', async () => {
  await writeFile(join(root, 'auth.json'), '{ nope');
  await config('[model_providers.a]\nbase_url = "https://a.example.test/v1"\nenv_key = "K"\n');
  const found = await scan({ K: KEY });
  expect(found.issues).toEqual([{ code: 'invalid-config', where: 'auth.json' }]);
  expect(found.connections).toHaveLength(1);
});

it('an unreadable file is an issue, not an empty discovery', async () => {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  await chmod(join(root, 'auth.json'), 0o000);
  try {
    const found = await scan({});
    expect(found.connections).toEqual([]);
    expect(found.issues).toEqual([{ code: 'unreadable', where: 'auth.json' }]);
  } finally { await chmod(join(root, 'auth.json'), 0o600); }
});

it('a sign-in kept outside auth.json is not an authority for the file; providers and shell keys still list', async () => {
  await config('cli_auth_credentials_store = "keyring"\n[model_providers.a]\nbase_url = "https://a.example.test/v1"\nenv_key = "K"\n');
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  const found = await scan({ K: OTHER_KEY });
  expect(found.issues).toEqual([{ code: 'unsupported-store', where: 'auth.json' }]);
  expect(found.connections).toMatchObject([{ source: 'codex-provider' }]);
});

it('a missing directory is a zero discovery, not an error', async () => {
  const found = await discoverLocalConnections({ root: join(root, 'absent'), env: {} });
  expect(found).toEqual({ connections: [], issues: [] });
});

it('only reads: no file or directory entry changes, and nothing is run or requested', async () => {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  await config('[model_providers.a]\nbase_url = "https://a.example.test/v1"\nenv_key = "K"\n');
  await mkdir(join(root, 'sessions'));
  const request = vi.fn(() => { throw new Error('discovery must not use the network'); });
  vi.stubGlobal('fetch', request);
  const before = await snapshot();
  await scan({ K: OTHER_KEY, OPENAI_API_KEY: KEY });
  expect(await snapshot()).toEqual(before);
  expect(request).not.toHaveBeenCalled();
});

it('its diagnostics and public fields never carry a key, only the last four characters', async () => {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  await config('[model_providers.a]\nbase_url = "https://a.example.test/v1?x=1"\nenv_key = "K"\n[model_providers.b]\nbase_url = "https://b.example.test/v1"\nenv_key = "KB"\n');
  const found = await scan({ K: OTHER_KEY, KB: 'sk-live-bbbbbbbbbbbbbbbbbbbb' });
  const text = JSON.stringify(found);
  for (const secret of [KEY, OTHER_KEY, 'sk-live-bbbbbbbbbbbbbbbbbbbb']) expect(text).not.toContain(secret);
  expect(found.connections.every(connection => connection.keyLast4.length === 4)).toBe(true);
});

it('names the unreadable sources in a form the log redactor leaves alone', () => {
  const issues: DiscoveryIssue[] = [
    { code: 'incompatible', where: 'config.toml', provider: 'query' },
    { code: 'key-missing', where: 'config.toml', provider: 'acme' },
    { code: 'invalid-config', where: 'config.toml' },
    { code: 'unreadable', where: 'auth.json' },
    { code: 'unsupported-store', where: 'auth.json' },
  ];
  const signature = describeDiscoveryIssues(issues);
  expect(signature).toBe('incompatible:config.toml:query key-missing:config.toml:acme invalid-config:config.toml unreadable:auth.json unsupported-store:auth.json');
  expect(redactAll(signature)).toBe(signature);
});


it('pairs the selected Codex relay with the file API key without generating an official OpenAI entry', async () => {
  await config('model_provider = "relay"\nmodel = "example-model"\n[model_providers.relay]\nbase_url = "https://relay.example.test/v1"\nrequires_openai_auth = true\n');
  await auth({ OPENAI_API_KEY: KEY });
  const found = await scan({});
  expect(found.connections).toHaveLength(1);
  expect(found.connections[0]).toMatchObject({ nativeHarnesses: ['codex'], models: [{ id: 'example-model' }], endpoints: [{ baseUrl: 'https://relay.example.test/v1', protocol: 'openai-responses' }] });
  expect(discoveredSecret(found.connections[0]!)).toBe(KEY);
});


it('recognizes a dedicated Coding Plan endpoint and leaves a shared endpoint unclassified', async () => {
  await config('[model_providers.dedicated]\nbase_url = "https://api.kimi.com/coding/v1"\nenv_key = "K"\n[model_providers.shared]\nbase_url = "https://open.bigmodel.cn/api/anthropic"\nenv_key = "K"\n');
  const found = await scan({ K: KEY });
  expect(found.connections.find(connection => connection.name === 'dedicated')?.preset).toBe('kimi-coding');
  expect(found.connections.find(connection => connection.name === 'shared')?.preset).toBeNull();
});
