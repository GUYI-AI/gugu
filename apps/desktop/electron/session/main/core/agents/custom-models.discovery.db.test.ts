import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { providerAccounts, sessions } from '@main/db/schema';
import { customModelOptionId } from '@gugu/session-core/models/custom-model';
import { releaseCustomModelForwarders } from './custom-model-forwarder';

const state = vi.hoisted(() => ({ fixture: null as RegistryFixture | null }));
vi.mock('@main/db/client', () => ({ get db() { return state.fixture!.db; } }));
vi.mock('@main/core/provider-accounts/provider-account-registry-instance', () => ({ get providerAccountRegistry() { return state.fixture!.registry; } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
// The host injects the login-shell snapshot; the user's own shell must not decide what these tests find.
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => null }));
const { listCustomModels, saveCustomModel, removeCustomModel, testCustomModel, resolveCustomModel, validateCustomModelSelection } = await import('./custom-models');

const KEY = 'sk-live-0123456789abcdefWXYZ';
const ROTATED = 'sk-live-ffffffffffffffffQRST';
const ACME = 'https://acme.example.test/v1';
let home: string;

beforeEach(async () => {
  state.fixture = await openRegistryFixture('empty');
  state.fixture.sqlite.exec("INSERT INTO projects (id, name, path) VALUES ('project','Project','/repo')");
  home = await mkdtemp(join(tmpdir(), 'codex-home-'));
  vi.stubEnv('CODEX_HOME', home);
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ACME_API_KEY']) vi.stubEnv(name, '');
});
afterEach(async () => {
  releaseCustomModelForwarders(); state.fixture?.close(); state.fixture = null;
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true });
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

it('shows what the machine already has in the existing list without writing a row, a secret or a default', async () => {
  await twoFound();
  const before = { rows: allRows().length, secrets: state.fixture!.secretStore.secrets.size };
  const list = await listCustomModels();
  expect(list.map(connection => connection.name).sort()).toEqual(['Acme Gateway', 'OpenAI']);
  expect(await named('OpenAI')).toMatchObject({ preset: 'openai', keySaved: true, discovered: { source: 'codex-auth', keyLast4: 'WXYZ' } });
  expect(await named('Acme Gateway')).toMatchObject({ preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: ACME }], models: [{ id: 'acme-large' }], discovered: { source: 'codex-provider', keyLast4: 'QRST' } });
  expect({ rows: allRows().length, secrets: state.fixture!.secretStore.secrets.size }).toEqual(before);
  expect(JSON.stringify(list)).not.toContain(KEY);
  expect(JSON.stringify(list)).not.toContain(ROTATED);
  expect(Object.keys((await named('OpenAI')).discovered!).sort()).toEqual(['keyLast4', 'source']);
});

it('keeps the same ids and the same count however often it is read', async () => {
  await twoFound();
  const first = await listCustomModels();
  for (let index = 0; index < 4; index += 1) expect(await listCustomModels()).toEqual(first);
  expect(allRows()).toHaveLength(0);
});

it('writes the connection once, under the id it was shown with, only when someone first uses it', async () => {
  await twoFound();
  const acme = await named('Acme Gateway');
  await expect(validateCustomModelSelection('codex', { kind: 'custom', connectionId: acme.id, modelId: 'acme-large' })).resolves.toEqual({ id: 'acme-large' });
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({ accountId: acme.id });
  expect([...state.fixture!.secretStore.secrets.values()]).toEqual([ROTATED]);
  expect(JSON.stringify(rows()[0]!.meta)).not.toContain(ROTATED);
  expect(rows()[0]!.meta?.customModel?.discovery).toMatchObject({ source: 'codex-provider', keyLast4: 'QRST' });
  const again = await listCustomModels();
  expect(again.map(connection => connection.id).sort()).toEqual([acme.id, (await named('OpenAI')).id].sort());
  expect(again).toHaveLength(2);
  session('bound', 'codex', customModelOptionId({ connectionId: acme.id, modelId: 'acme-large' }));
  expect((await resolveCustomModel('codex', 'bound'))?.models[0]).toBe('acme-large');
  expect(rows()).toHaveLength(1);
});

it('two callers using the same unsaved connection at once still make one row and one secret', async () => {
  await twoFound();
  const { id } = await named('Acme Gateway');
  const use = () => validateCustomModelSelection('codex', { kind: 'custom', connectionId: id, modelId: 'acme-large' });
  await Promise.all([use(), use(), use(), use(), use()]);
  expect(rows()).toHaveLength(1);
  expect(state.fixture!.secretStore.secrets.size).toBe(1);
});

it('refuses an id whose source changed before it was used, and never points it at another key', async () => {
  await twoFound();
  const old = await named('Acme Gateway');
  vi.stubEnv('ACME_API_KEY', 'sk-live-newnewnewnewnewNEWK');
  await expect(validateCustomModelSelection('codex', { kind: 'custom', connectionId: old.id, modelId: 'acme-large' })).rejects.toThrow('no longer exists');
  expect(rows()).toHaveLength(0);
  const next = await named('Acme Gateway');
  expect(next.id).not.toBe(old.id);
  expect(next.discovered?.keyLast4).toBe('NEWK');
});

it('prefers an existing saved connection with the same address and key, in the list and for new sources', async () => {
  await twoFound();
  const saved = await saveCustomModel({ name: 'My Acme', apiKey: ROTATED, preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: ACME }], models: [{ id: 'mine' }] });
  const list = await listCustomModels();
  expect(list.map(connection => connection.name).sort()).toEqual(['My Acme', 'OpenAI']);
  expect(list.find(connection => connection.name === 'My Acme')!.id).toBe(saved.id);
  expect(rows()).toHaveLength(1);
});

it('a saved connection with a different key does not hide the discovered one', async () => {
  await twoFound();
  await saveCustomModel({ name: 'Other Acme key', apiKey: 'sk-live-someoneelsesomeoneEL', preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: ACME }], models: [{ id: 'mine' }] });
  expect((await listCustomModels()).map(connection => connection.name).sort()).toEqual(['Acme Gateway', 'OpenAI', 'Other Acme key']);
});

it('removing a discovered connection keeps it removed on every later scan and keeps its row for bound sessions', async () => {
  await twoFound();
  const acme = await named('Acme Gateway');
  await removeCustomModel(acme.id);
  for (let index = 0; index < 3; index += 1) expect((await listCustomModels()).map(connection => connection.name)).toEqual(['OpenAI']);
  expect(rows()).toHaveLength(1);
  expect(rows()[0]!.meta?.customModel).toMatchObject({ removed: true, discovery: { source: 'codex-provider' } });
});

it('editing a discovered connection saves it as that connection and keeps its discovery identity', async () => {
  await twoFound();
  const acme = await named('Acme Gateway');
  const saved = await saveCustomModel({ id: acme.id, name: 'Acme renamed', preset: null, endpoints: acme.endpoints, models: [{ id: 'picked' }] });
  expect(saved).toMatchObject({ id: acme.id, name: 'Acme renamed', models: [{ id: 'picked' }], keySaved: true });
  const list = await listCustomModels();
  expect(list.map(connection => connection.name).sort()).toEqual(['Acme renamed', 'OpenAI']);
  expect(rows()).toHaveLength(1);
  expect(rows()[0]!.meta?.customModel?.discovery).toMatchObject({ source: 'codex-provider', keyLast4: 'QRST' });
});

it('testing a discovered connection uses its key only in the host request', async () => {
  await twoFound();
  const acme = await named('Acme Gateway');
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ data: [{ id: 'acme-large' }] }));
  vi.stubGlobal('fetch', fetcher);
  expect(await testCustomModel({ connectionId: acme.id })).toEqual({ kind: 'listed', models: ['acme-large'] });
  expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization')).toBe(`Bearer ${ROTATED}`);
});

it('a connection that was written once stays after its source disappears', async () => {
  await twoFound();
  const acme = await named('Acme Gateway');
  await validateCustomModelSelection('codex', { kind: 'custom', connectionId: acme.id, modelId: 'acme-large' });
  session('bound', 'codex', customModelOptionId({ connectionId: acme.id, modelId: 'acme-large' }));
  await rm(join(home, 'config.toml'));
  vi.stubEnv('ACME_API_KEY', '');
  expect((await listCustomModels()).map(connection => connection.name).sort()).toEqual(['Acme Gateway', 'OpenAI']);
  expect(rows()).toHaveLength(1);
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
