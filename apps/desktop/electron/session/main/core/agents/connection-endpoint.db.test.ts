import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { automations, kv, providerAccounts, sessions, appSettings } from '@main/db/schema';
import { customModelOptionId, customModelRefFromOption } from '@gugu/session-core/models/custom-model';
import { saveCustomModelSchema } from '@gugu/session-core/workspace-server/agent-config';
import { releaseCustomModelForwarders } from './custom-model-forwarder';
import { migrateCustomModels } from './custom-model-migration';
const state = vi.hoisted(() => ({ fixture: null as RegistryFixture | null }));
vi.mock('@main/db/client', () => ({ get db() { return state.fixture!.db; } }));
vi.mock('@main/core/provider-accounts/provider-account-registry-instance', () => ({ get providerAccountRegistry() { return state.fixture!.registry; } }));
const { saveCustomModel, listCustomModels, resolveCustomModel, testCustomModel, removeCustomModel, validateCustomModelSelection } = await import('./custom-models');
const { resolveCustomModelRunContext } = await import('./custom-model-run-context');
const endpoints = [{ protocol: 'openai-responses' as const, baseUrl: 'https://provider.test/v1' }, { protocol: 'anthropic-messages' as const, baseUrl: 'https://provider.test/anthropic' }];
beforeEach(async () => {
  state.fixture = await openRegistryFixture('empty');
  state.fixture.sqlite.exec("INSERT INTO projects (id, name, path) VALUES ('project','Project','/repo')");
});
afterEach(() => { releaseCustomModelForwarders(); state.fixture?.close(); state.fixture = null; vi.unstubAllGlobals(); });
function session(id: string, provider: string, model?: string, connectionId?: string) {
  state.fixture!.db.insert(sessions).values({ id, projectId: 'project', provider, runtime: 'acp', config: { version: '1', type: 'acp', ...(model ? { model } : {}), ...(connectionId ? { subscriptionConnectionId: connectionId } : {}) } }).run();
}
async function legacy(provider: string, models?: string[], endpoint?: string) {
  const id = randomUUID();
  await state.fixture!.registry.upsertAccount({ providerId: `harness:${provider}`, accountId: id, secret: 'fixture-secret', meta: { displayName: 'Existing provider', harnessConnection: { kind: 'api-key', ...(models ? { models } : {}), ...(endpoint ? { endpoint } : {}) } } });
  await state.fixture!.registry.setDefaultAccount(`harness:${provider}`, id);
  return (await state.fixture!.registry.getAccount(`harness:${provider}`, id))!;
}
it('saves one encrypted provider record, lists no secret, and keeps existing sessions bound across edits/removal', async () => {
  const connection = await saveCustomModel({ name: 'My provider', apiKey: 'fixture-secret', preset: null, endpoints, models: [{ id: 'model:a', contextWindow: 32768 }, { id: 'model/b' }] });
  session('a', 'codex', customModelOptionId({ connectionId: connection.id, modelId: 'model:a' }));
  session('b', 'codex', customModelOptionId({ connectionId: connection.id, modelId: 'model/b' }));
  expect(JSON.stringify(await listCustomModels())).not.toContain('fixture-secret');
  expect(state.fixture!.sqlite.prepare('SELECT meta FROM provider_accounts').all().map((row) => JSON.stringify(row)).join('')).not.toContain('fixture-secret');
  expect((await resolveCustomModel('codex', 'a'))?.models[0]).toBe('model:a');
  expect((await resolveCustomModel('codex', 'b'))?.models[0]).toBe('model/b');
  await saveCustomModel({ ...connection, apiKey: undefined, models: [{ id: 'next' }] });
  await expect(validateCustomModelSelection('codex', { kind: 'custom', connectionId: connection.id, modelId: 'model:a' }))
    .rejects.toThrow('Select a model currently listed');
  await expect(validateCustomModelSelection('codex', { kind: 'custom', connectionId: connection.id, modelId: 'next' }))
    .resolves.toEqual({ id: 'next' });
  expect((await resolveCustomModel('codex', 'a'))?.models[0]).toBe('model:a');
  await removeCustomModel(connection.id);
  expect(await listCustomModels()).toEqual([]);
  expect((await resolveCustomModel('codex', 'a'))?.apiKey).toMatch(/^sk-gugu-/);
});
it('migration reuses credential references, restores the original official endpoint, preserves models and is idempotent after downgrade strips the marker', async () => {
  const old = await legacy('dsh');
  session('existing', 'dsh', 'old-model', old.accountId);
  session('default', 'dsh');
  session('platform', 'dsh');
  state.fixture!.db.insert(kv).values({ key: 'sessionpage-platform-model:platform', value: JSON.stringify({ platformModel: { modelId: 'paid-model' } }) }).run();
  state.fixture!.db.insert(automations).values({ id: 'auto', name: 'Auto', createdAt: 1, updatedAt: 1, agentConfig: { provider: 'dsh', prompt: 'hello', autoApprove: false, model: 'scheduled-model' } }).run();
  state.fixture!.db.insert(appSettings).values({ key: 'newSessionMemory', value: JSON.stringify({ lastStarted: { provider: 'dsh', model: 'remembered-model', providerChosenByUser: true } }) }).run();
  migrateCustomModels(state.fixture!.db, new Set(['kilocode', 'mimocode']));
  const migrated = state.fixture!.db.select().from(providerAccounts).where(eq(providerAccounts.providerId, 'models:custom')).get()!;
  expect(migrated.credentialRef).toBe(old.credentialRef);
  expect(migrated.meta?.customModel).toMatchObject({ endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' }], models: [] });
  const read = (id: string) => state.fixture!.db.select().from(sessions).where(eq(sessions.id, id)).get()!.config!.model;
  expect(customModelRefFromOption(read('existing'))).toMatchObject({ connectionId: migrated.accountId, modelId: 'old-model' });
  expect(customModelRefFromOption(read('default'))).toEqual({ kind: 'custom', connectionId: migrated.accountId });
  expect(read('platform')).toBeUndefined();
  expect(customModelRefFromOption(state.fixture!.db.select().from(automations).get()!.agentConfig?.model)?.modelId).toBe('scheduled-model');
  expect(JSON.parse(state.fixture!.db.select().from(appSettings).get()!.value).lastStarted.model).toBe(customModelOptionId({ connectionId: migrated.accountId, modelId: 'remembered-model' }));
  state.fixture!.db.update(providerAccounts).set({ meta: old.meta }).where(eq(providerAccounts.accountId, old.accountId)).run();
  migrateCustomModels(state.fixture!.db, new Set(['kilocode', 'mimocode']));
  expect(state.fixture!.db.select().from(providerAccounts).where(eq(providerAccounts.providerId, 'models:custom')).all()).toHaveLength(1);
  expect(state.fixture!.secretStore.secrets.size).toBe(1);
});
it('migrates a Pi ACP model reported with a provider prefix to the upstream model ID', async () => {
  const old = await legacy('pi', ['family/model'], 'https://provider.test/v1');
  session('pi-source', 'pi', 'Existing provider/family/model', old.accountId);
  migrateCustomModels(state.fixture!.db, new Set());
  const migrated = state.fixture!.db.select().from(providerAccounts)
    .where(eq(providerAccounts.providerId, 'models:custom')).get()!;
  expect(customModelRefFromOption(state.fixture!.db.select().from(sessions).get()!.config?.model)).toEqual({
    kind: 'custom', connectionId: migrated.accountId, modelId: 'family/model',
  });
});

it.each(['claude', 'codex', 'opencode'])('%s launch receives the selected model, never its storage encoding', async (provider) => {
  const record = await saveCustomModel({ name: 'Provider', apiKey: 'fixture-secret', preset: null, endpoints, models: [{ id: 'model:1' }] });
  const encoded = customModelOptionId({ connectionId: record.id, modelId: 'model:1' });
  session('launch', provider, encoded);
  const resolved = await resolveCustomModel(provider, 'launch');
  const context = await resolveCustomModelRunContext(provider, 'launch');
  expect(JSON.stringify(context)).not.toContain(encoded);
  expect(resolved?.models).toEqual(['model:1']);
  const fork = await resolveCustomModel(provider, 'runtime-fork', 'launch');
  expect(fork?.models).toEqual(['model:1']);
  expect(fork?.endpoint).toBe(resolved?.endpoint);
  if (provider === 'claude') expect(context.credentialEnv).toMatchObject({ ANTHROPIC_MODEL: 'model:1', ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) });
  expect(JSON.stringify(context)).not.toContain('fixture-secret');
  if (provider === 'codex') expect(context.extraArgs).toContain('model="model:1"');
});
it.each(['claude', 'codex', 'dsh'])('%s empty migrated records run with CLI defaults', async (provider) => {
  const old = await legacy(provider);
  session('default', provider, undefined, old.accountId);
  const [record] = await listCustomModels();
  expect((await resolveCustomModel(provider, 'default'))?.models).toEqual([]);
  const context = await resolveCustomModelRunContext(provider, 'default');
  expect(context.credentialEnv).not.toHaveProperty('ANTHROPIC_MODEL');
  expect(context.extraArgs ?? []).not.toContain('model=');
  if (provider === 'codex') {
    session('no-model', 'opencode', customModelOptionId({ connectionId: record!.id }));
    await expect(resolveCustomModel('opencode', 'no-model')).rejects.toThrow('no-model');
  }
  expect(saveCustomModelSchema.safeParse({ name: 'New', apiKey: 'k', preset: null, endpoints, models: [] }).success).toBe(false);
});
it('missing local credentials remain visible and fail on the running device', async () => {
  const record = await saveCustomModel({ name: 'Provider', apiKey: 'fixture-secret', preset: null, endpoints, models: [{ id: 'm' }] });
  state.fixture!.secretStore.secrets.clear();
  expect(await listCustomModels()).toMatchObject([{ id: record.id, keySaved: false }]);
  session('missing-key', 'codex', customModelOptionId({ connectionId: record.id, modelId: 'm' }));
  await expect(resolveCustomModel('codex', 'missing-key')).rejects.toThrow('missing-key');
});
it('tests an edited address using its saved key only in the host request', async () => {
  const record = await saveCustomModel({ name: 'Provider', apiKey: 'fixture-secret', preset: null, endpoints, models: [{ id: 'm' }] });
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }));
  vi.stubGlobal('fetch', fetcher);
  expect(await testCustomModel({ connectionId: record.id, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://edited.test/v1' }] })).toEqual({ kind: 'listed', models: ['a', 'b'] });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://edited.test/v1/models');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-secret');
  expect(init?.redirect).toBe('error');
});

it('only performs a model request from an explicit test when no models are listed', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => new Response(null, { status: init?.method === 'POST' ? 200 : 404 }));
  vi.stubGlobal('fetch', fetcher);
  const input = { apiKey: 'fixture-secret', endpoints: [{ protocol: 'anthropic-messages' as const, baseUrl: 'https://provider.test/anthropic' }] };
  expect(await testCustomModel(input)).toEqual({ kind: 'unlisted', reason: 'no-list' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await testCustomModel({ ...input, modelId: 'model-1' })).toEqual({ kind: 'connected' });
  const [url, init] = fetcher.mock.calls[2]!;
  expect(url).toBe('https://provider.test/anthropic/v1/messages/count_tokens');
  expect(new Headers(init?.headers).get('x-api-key')).toBe('fixture-secret');
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'model-1' });
});
