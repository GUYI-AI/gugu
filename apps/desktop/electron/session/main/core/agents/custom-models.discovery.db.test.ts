import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { providerAccounts, sessions } from '@main/db/schema';
import { customModelOptionId } from '@gugu/session-core/models/custom-model';
import { installEnvironmentFetch } from '@gugu/core/shared/egress';
import { createEnvironmentFetch } from '../../../../egress/environment';
import { releaseCustomModelForwarders } from './custom-model-forwarder';

const state = vi.hoisted(() => ({ fixture: null as RegistryFixture | null }));
vi.mock('@main/db/client', () => ({ get db() { return state.fixture!.db; } }));
vi.mock('@main/core/provider-accounts/provider-account-registry-instance', () => ({ get providerAccountRegistry() { return state.fixture!.registry; } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
// The host injects the login-shell snapshot; the user's own shell must not decide what these tests find.
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => null }));
const { listCustomModels, saveCustomModel, removeCustomModel, testCustomModel, resolveCustomModel, validateCustomModelSelection, dropRemovedConnectionKeys } = await import('./custom-models');

const KEY = 'sk-live-0123456789abcdefWXYZ';
const ROTATED = 'sk-live-ffffffffffffffffQRST';
const ACME = 'https://acme.example.test/v1';
let home: string;

beforeEach(async () => {
  state.fixture = await openRegistryFixture('empty');
  state.fixture.sqlite.exec("INSERT INTO projects (id, name, path) VALUES ('project','Project','/repo')");
  home = await mkdtemp(join(tmpdir(), 'codex-home-'));
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', home);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) vi.stubEnv(name, '');
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ACME_API_KEY']) vi.stubEnv(name, '');
  // Listing probes a discovered custom address; these tests stay off the network unless one answers for itself.
  installEnvironmentFetch(async () => { throw new TypeError('offline'); });
});
afterEach(async () => {
  releaseCustomModelForwarders(); state.fixture?.close(); state.fixture = null;
  installEnvironmentFetch(createEnvironmentFetch()); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true });
});

const auth = (value: unknown) => writeFile(join(home, 'auth.json'), JSON.stringify(value));
const config = (text: string) => writeFile(join(home, 'config.toml'), text);
const acmeConfig = () => config(`model_provider = "acme"\nmodel = "acme-large"\n[model_providers.acme]\nname = "Acme Gateway"\nbase_url = "${ACME}"\nenv_key = "ACME_API_KEY"\n`);
const rows = () => state.fixture!.db.select().from(providerAccounts).where(eq(providerAccounts.providerId, 'models:custom')).all();
const allRows = () => state.fixture!.db.select().from(providerAccounts).all();
const named = async (name: string) => (await listCustomModels()).find(connection => connection.name === name)!;
function session(id: string, provider: string, model: string) {
  state.fixture!.db.insert(sessions).values({ id, projectId: 'project', provider, runtime: 'acp', config: { version: '1', type: 'acp', model } }).run();
}
async function twoFound() {
  await auth({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  await acmeConfig();
  vi.stubEnv('ACME_API_KEY', ROTATED);
}

it('automatically saves the discovered connections once and exposes no keys', async () => {
  await twoFound();
  const [first, second] = await Promise.all([listCustomModels(), listCustomModels()]);
  expect(first).toEqual(second);
  expect(rows()).toHaveLength(2);
  expect(state.fixture!.secretStore.secrets.size).toBe(2);
  expect(first).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'OpenAI', preset: 'openai', models: [] }),
    expect.objectContaining({ name: 'Acme Gateway', managedNativeHarnesses: ['codex'], models: [{ id: 'acme-large' }] }),
  ]));
  expect(JSON.stringify(first)).not.toContain(KEY);
  expect(JSON.stringify(first)).not.toContain(ROTATED);
});

it('merges the same URL and key while preserving disabled models', async () => {
  const saved = await saveCustomModel({ name: 'My Acme', apiKey: ROTATED, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: ACME }], models: [{ id: 'mine' }], disabledModels: [{ id: 'acme-large', image: false }] });
  await twoFound();
  expect(await named('My Acme')).toMatchObject({ id: saved.id, models: [{ id: 'mine' }], disabledModels: [{ id: 'acme-large', image: false }], managedNativeHarnesses: ['codex'] });
  await expect(validateCustomModelSelection('codex', { kind: 'custom', connectionId: saved.id, modelId: 'acme-large' })).rejects.toThrow('Select a model');
});

it('shows an imported key conflict without storing the second key and honors the user choice', async () => {
  const mine = await saveCustomModel({ name: 'My Acme', apiKey: KEY, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: ACME }], models: [{ id: 'mine' }] });
  await twoFound();
  const candidate = await named('Acme Gateway');
  expect(candidate).toMatchObject({ keyConflict: true });
  expect(await named('My Acme')).toMatchObject({ keyConflict: true });
  expect([...state.fixture!.secretStore.secrets.values()]).not.toContain(ROTATED);
  await expect(validateCustomModelSelection('codex', { kind: 'custom', connectionId: candidate.id, modelId: 'acme-large' })).rejects.toThrow('no longer exists');
  await saveCustomModel({ id: mine.id, name: mine.name, preset: mine.preset, endpoints: mine.endpoints, models: [], resolveUrlConflict: true });
  expect(await named('My Acme')).toMatchObject({ models: [{ id: 'mine' }, { id: 'acme-large' }] });
  expect(await named('Acme Gateway')).toBeUndefined();
});

it('does not create a second configuration for a discovered URL with a different key', async () => {
  await twoFound();
  await expect(saveCustomModel({ name: 'Other Acme key', apiKey: KEY, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: ACME }], models: [{ id: 'mine' }] })).rejects.toThrow('already has a key');
  expect((await listCustomModels()).map(connection => connection.name).sort()).toEqual(['Acme Gateway', 'OpenAI']);
});

const atAcme = { name: 'Acme', preset: null, endpoints: [{ protocol: 'openai-responses' as const, baseUrl: ACME }] };

it('serializes simultaneous additions to one normalized URL and merges models without replacing the saved key', async () => {
  const first = saveCustomModel({ ...atAcme, apiKey: KEY, apiUrl: `${ACME}/`, models: [{ id: 'a' }] });
  const second = saveCustomModel({ ...atAcme, apiUrl: ACME, models: [{ id: 'b' }, { id: 'a' }] });
  const [a, b] = await Promise.all([first, second]);
  expect(b.id).toBe(a.id);
  expect(b.models).toEqual([{ id: 'a' }, { id: 'b' }]);
  await expect(saveCustomModel({ ...atAcme, apiKey: ROTATED, models: [{ id: 'c' }] })).rejects.toThrow('already has a key');
  const other = await saveCustomModel({ ...atAcme, apiUrl: 'https://acme.example.test/other', endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://acme.example.test/other' }], apiKey: ROTATED, models: [{ id: 'c' }] });
  expect(other.id).not.toBe(a.id);
  expect(rows()).toHaveLength(2);
});

async function legacy(id: string, key: string, model: string) {
  await state.fixture!.registry.upsertAccount({ providerId: 'models:custom', accountId: id, secret: key,
    meta: { displayName: 'Acme', customModel: { preset: null, endpoints: atAcme.endpoints, models: [{ id: model }] } } });
}

it('merges legacy duplicates with the same key and preserves bound session references', async () => {
  const firstId = '10000000-0000-4000-8000-000000000001';
  const secondId = '10000000-0000-4000-8000-000000000002';
  await legacy(firstId, KEY, 'a');
  await legacy(secondId, KEY, 'b');
  session('old-a', 'codex', customModelOptionId({ connectionId: firstId, modelId: 'a' }));
  session('old-b', 'codex', customModelOptionId({ connectionId: secondId, modelId: 'b' }));
  const listed = await listCustomModels();
  expect(listed).toHaveLength(1);
  expect(listed[0]!.models).toEqual(expect.arrayContaining([{ id: 'a' }, { id: 'b' }]));
  expect((await resolveCustomModel('codex', 'old-a'))?.models[0]).toBe('a');
  expect((await resolveCustomModel('codex', 'old-b'))?.models[0]).toBe('b');
  expect(state.fixture!.secretStore.secrets.size).toBe(1);
});

it('requires an explicit saved key choice for conflicting legacy duplicates', async () => {
  await legacy('10000000-0000-4000-8000-000000000001', KEY, 'a');
  await legacy('10000000-0000-4000-8000-000000000002', ROTATED, 'b');
  expect(await listCustomModels()).toHaveLength(2);
  await expect(saveCustomModel({ ...atAcme, models: [{ id: 'c' }] })).rejects.toThrow('multiple saved keys');
  const winner = await saveCustomModel({ ...atAcme, id: '10000000-0000-4000-8000-000000000002', models: [], resolveUrlConflict: true });
  expect(winner.keyLast4).toBe('QRST');
  expect(winner.models).toEqual([{ id: 'b' }, { id: 'a' }]);
  expect(await listCustomModels()).toHaveLength(1);
});

it('removing a discovered connection keeps it removed on every later scan and keeps its row for bound sessions', async () => {
  await twoFound();
  const acme = await named('Acme Gateway');
  await removeCustomModel(acme.id);
  for (let index = 0; index < 3; index += 1) expect((await listCustomModels()).map(connection => connection.name)).toEqual(['OpenAI']);
  expect(rows()).toHaveLength(2);
  expect(rows().find(row => row.accountId === acme.id)!.meta?.customModel).toMatchObject({ removed: true, discovery: { source: 'codex-provider' } });
});

it('removing a connection drops its key from encrypted storage, saved by hand or first used from a discovery, and bound sessions stop at unavailable', async () => {
  await twoFound();
  const manual = await saveCustomModel({ name: 'By hand', preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://hand.example.test/v1' }], models: [{ id: 'm' }], apiKey: 'sk-live-handhandhandhandhand' });
  const acme = await named('Acme Gateway');
  await saveCustomModel({ id: acme.id, name: acme.name, preset: null, endpoints: acme.endpoints, models: [{ id: 'acme-large' }] });
  expect(state.fixture!.secretStore.secrets.size).toBe(3);
  session('bound', 'codex', customModelOptionId({ connectionId: manual.id, modelId: 'm' }));
  await removeCustomModel(manual.id);
  await removeCustomModel(acme.id);
  expect([...state.fixture!.secretStore.secrets.values()]).toEqual([KEY]);
  expect(rows().filter(row => row.meta?.customModel?.removed)).toHaveLength(2);
  await expect(resolveCustomModel('codex', 'bound')).rejects.toThrow('Custom model unavailable');
});

const OPENAI = 'https://api.openai.com/v1';
const names = async () => (await listCustomModels()).map(connection => connection.name).sort();

it('a connection saved by hand and removed does not make the same key on this machine come back, though its key is gone', async () => {
  await twoFound();
  const mine = await saveCustomModel({ name: 'OpenAI', apiKey: KEY, preset: 'openai', endpoints: [{ protocol: 'openai-responses', baseUrl: OPENAI }], models: [{ id: 'm' }] });
  expect(await names()).toEqual(['Acme Gateway', 'OpenAI']);
  await removeCustomModel(mine.id);
  expect([...state.fixture!.secretStore.secrets.values()]).toEqual([ROTATED]);
  for (let index = 0; index < 2; index += 1) expect(await names()).toEqual(['Acme Gateway']);
  expect(JSON.stringify(rows()[0]!.meta)).not.toContain(KEY);
});

it('a connection removed by an earlier build loses its key at startup and still does not come back', async () => {
  await twoFound();
  await state.fixture!.registry.upsertAccount({
    providerId: 'models:custom', accountId: 'earlier', secret: KEY,
    meta: { displayName: 'Earlier', customModel: { preset: 'openai', endpoints: [{ protocol: 'openai-responses', baseUrl: OPENAI }], models: [{ id: 'm' }], removed: true } },
  });
  expect(await names()).toEqual(['Acme Gateway']);
  await dropRemovedConnectionKeys();
  expect([...state.fixture!.secretStore.secrets.values()]).toEqual([ROTATED]);
  expect(await names()).toEqual(['Acme Gateway']);
  const before = rows()[0]!.updatedAt;
  await dropRemovedConnectionKeys();
  expect(rows()[0]!.updatedAt).toBe(before);
  expect(JSON.stringify(rows()[0]!.meta)).not.toContain(KEY);
});

it('editing a discovered connection saves it as that connection and keeps its discovery identity', async () => {
  await twoFound();
  const acme = await named('Acme Gateway');
  const saved = await saveCustomModel({ id: acme.id, name: 'Acme renamed', preset: null, endpoints: acme.endpoints, models: [{ id: 'picked' }] });
  expect(saved).toMatchObject({ id: acme.id, name: 'Acme renamed', models: [{ id: 'picked' }], keySaved: true });
  const list = await listCustomModels();
  expect(list.map(connection => connection.name).sort()).toEqual(['Acme renamed', 'OpenAI']);
  expect(rows()).toHaveLength(2);
  expect(rows().find(row => row.accountId === acme.id)!.meta?.customModel?.discovery).toMatchObject({ source: 'codex-provider', keyLast4: 'QRST' });
});

it('a discovered custom address is listed with every protocol it answers, not only the one its config names', async () => {
  await acmeConfig();
  vi.stubEnv('ACME_API_KEY', 'sk-live-probedprobedprobedPRBD');
  installEnvironmentFetch(async (_env, url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/models') return Response.json({ data: [{ id: 'acme-large' }] });
    return new Response('{}', { status: path === '/v1/messages' || path === '/v1/responses' ? 200 : 404 });
  });
  expect((await named('Acme Gateway')).endpoints).toEqual([
    { protocol: 'anthropic-messages', baseUrl: 'https://acme.example.test' },
    { protocol: 'openai-responses', baseUrl: ACME },
  ]);
});

it('testing an imported connection uses its key only in the host request', async () => {
  await twoFound();
  const acme = await named('Acme Gateway');
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ data: [{ id: 'acme-large' }] }));
  // The connection test leaves through the egress in the agent's environment.
  installEnvironmentFetch((_env, url, init) => fetcher(String(url), init));
  expect(await testCustomModel({ connectionId: acme.id })).toEqual({ kind: 'listed', models: ['acme-large'] });
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBe(`Bearer ${ROTATED}`);
});

it('an imported connection stays after its source disappears', async () => {
  await twoFound();
  const acme = await named('Acme Gateway');
  await validateCustomModelSelection('codex', { kind: 'custom', connectionId: acme.id, modelId: 'acme-large' });
  session('bound', 'codex', customModelOptionId({ connectionId: acme.id, modelId: 'acme-large' }));
  await rm(join(home, 'config.toml'));
  vi.stubEnv('ACME_API_KEY', '');
  expect((await listCustomModels()).map(connection => connection.name).sort()).toEqual(['Acme Gateway', 'OpenAI']);
  expect(rows()).toHaveLength(2);
  expect((await resolveCustomModel('codex', 'bound'))?.models[0]).toBe('acme-large');
});

it('does not touch any other connection list: no harness account rows, no default change', async () => {
  await twoFound();
  await validateCustomModelSelection('codex', { kind: 'custom', connectionId: (await named('Acme Gateway')).id, modelId: 'acme-large' });
  expect(allRows().filter(row => row.providerId !== 'models:custom')).toEqual([]);
});

it('an unreadable or broken source does not take the existing connections out of the list', async () => {
  const saved = await saveCustomModel({ name: 'Mine', apiKey: KEY, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://mine.example.test/v1' }], models: [{ id: 'm' }] });
  await config('not = = toml');
  expect((await listCustomModels()).map(connection => connection.id)).toEqual([saved.id]);
});


it('imports a directly configured Claude API key and explicit model', async () => {
  await writeFile(join(home, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://claude-relay.example.test', ANTHROPIC_API_KEY: KEY, ANTHROPIC_MODEL: 'claude-model',
  } }));
  expect(await listCustomModels()).toEqual([expect.objectContaining({ name: 'claude-relay.example.test',
    managedNativeHarnesses: ['claude'], models: [{ id: 'claude-model' }], keySaved: true })]);
});


it('adding a model to an existing address preserves its routes and declared Fast capability', async () => {
  const route = { id: '10000000-0000-4000-8000-000000000010', incoming: 'anthropic-messages', outgoing: 'openai-responses' } as const;
  const first = await saveCustomModel({ ...atAcme, apiKey: KEY, routes: [route], models: [{ id: 'a', fast: true }] });
  const added = await saveCustomModel({ ...atAcme, routes: [], models: [{ id: 'b' }] });
  expect(added).toMatchObject({ id: first.id, routes: [route], models: [{ id: 'a', fast: true }, { id: 'b' }] });
  const edited = await saveCustomModel({ ...atAcme, id: first.id, routes: [], models: added.models });
  expect(edited.routes).toEqual([]);
});

it('merging legacy connections with the same key retains both protocol routes', async () => {
  const routeA = { id: '10000000-0000-4000-8000-000000000011', incoming: 'anthropic-messages', outgoing: 'openai-responses', modelId: 'a' } as const;
  const routeB = { id: '10000000-0000-4000-8000-000000000012', incoming: 'gemini-generate-content', outgoing: 'openai-responses', modelId: 'b' } as const;
  for (const [id, model, route] of [
    ['10000000-0000-4000-8000-000000000001', 'a', routeA],
    ['10000000-0000-4000-8000-000000000002', 'b', routeB],
  ] as const) {
    await state.fixture!.registry.upsertAccount({ providerId: 'models:custom', accountId: id, secret: KEY,
      meta: { displayName: 'Acme', customModel: { preset: null, endpoints: atAcme.endpoints, models: [{ id: model }], routes: [route] } } });
  }
  const listed = await listCustomModels();
  expect(listed).toHaveLength(1);
  expect(listed[0]!.routes).toEqual(expect.arrayContaining([routeA, routeB]));
});
