import { customModelForwarder, customModelRoute } from './custom-model-forwarder';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import {
  customModelRefFromOption, matchCustomModel,
  type CustomModelConnection, type CustomModelMeta, type CustomModelRef, type ModelProtocol, type PiCustomModelProvider,
} from '@gugu/session-core/models/custom-model';
import type { ConnectionModelList, SaveCustomModel, TestCustomModel } from '@gugu/session-core/workspace-server/agent-config';
import { providerAccountRegistry as registry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { migrateCustomModels } from './custom-model-migration';
import { listEndpointModels, verifyEndpointModel } from './connection-endpoint-probe';

const namespace = 'models:custom';
const migratedDatabases = new WeakSet<object>();

export function migrateCustomModelConnections(): void {
  if (migratedDatabases.has(db)) return;
  const vendors = new Set(pluginRegistry.getAll().filter((plugin) =>
    plugin.capabilities.auth.kind === 'supported' && plugin.capabilities.auth.vendorKey,
  ).map((plugin) => plugin.metadata.id));
  migrateCustomModels(db, vendors);
  migratedDatabases.add(db);
}

async function view(id: string): Promise<CustomModelConnection> {
  const row = await registry.getAccount(namespace, id);
  if (!row?.meta?.customModel) throw new Error('The custom model no longer exists');
  return {
    id, name: row.meta.displayName || id, credentialRef: row.credentialRef,
    keySaved: Boolean(await registry.resolveSecret(namespace, id)), ...row.meta.customModel,
  };
}

export async function listCustomModels(): Promise<CustomModelConnection[]> {
  migrateCustomModelConnections();
  const rows = await registry.listAccounts(namespace);
  return Promise.all(rows.filter((row) => row.meta?.customModel && !row.meta.customModel.removed).map((row) => view(row.accountId)));
}

export async function saveCustomModel(input: SaveCustomModel): Promise<CustomModelConnection> {
  migrateCustomModelConnections();
  const id = input.id ?? randomUUID();
  const existing = input.id ? await registry.getAccount(namespace, input.id) : null;
  if (input.id && (!existing?.meta?.customModel || existing.meta.customModel.removed)) throw new Error('The custom model no longer exists');
  if (!input.apiKey && !(existing && await registry.resolveSecret(namespace, id))) throw new Error('An API key is required on this device');
  await registry.upsertAccount({
    providerId: namespace, accountId: id,
    ...(input.apiKey ? { secret: input.apiKey } : {}),
    meta: { displayName: input.name, customModel: { preset: input.preset, endpoints: input.endpoints, models: input.models } },
  });
  return view(id);
}

/** Soft deletion retains credentials for already-bound sessions and downgrade. */
export async function removeCustomModel(connectionId: string): Promise<void> {
  const row = await registry.getAccount(namespace, connectionId);
  if (!row?.meta?.customModel) throw new Error('The custom model no longer exists');
  await registry.upsertAccount({
    providerId: namespace, accountId: connectionId,
    meta: { ...row.meta, customModel: { ...row.meta.customModel, removed: true } },
  });
}

export async function testCustomModel(input: TestCustomModel): Promise<ConnectionModelList> {
  let endpoints = input.endpoints;
  let key = input.apiKey;
  if (input.connectionId) {
    const row = await registry.getAccount(namespace, input.connectionId);
    if (!row?.meta?.customModel) throw new Error('The custom model no longer exists');
    endpoints ??= row.meta.customModel.endpoints;
    key ??= (await registry.resolveSecret(namespace, input.connectionId)) ?? undefined;
  }
  if (!key) throw new Error('The model’s API key is unavailable on this device');
  const endpoint = endpoints?.find(({ protocol }) => protocol.startsWith('openai-')) ?? endpoints?.[0];
  if (!endpoint) throw new Error('An API address is required');
  const target = { endpoint: endpoint.baseUrl, apiKey: key, protocol: endpoint.protocol };
  const result = await listEndpointModels(target);
  return input.modelId && result.kind === 'unlisted' && result.reason === 'no-list'
    ? verifyEndpointModel(target, input.modelId)
    : result;
}

export type ResolvedCustomModel = {
  connectionId: string;
  name: string;
  endpoint: string;
  apiKey: string;
  models: string[];
  protocol: ModelProtocol;
  capabilities?: CustomModelMeta['models'][number];
  entries: CustomModelMeta['models'];
};

async function resolveCustomRoute(connectionId: string, protocol: ModelProtocol) {
  const row = await registry.getAccount(namespace, connectionId);
  const endpoint = row?.meta?.customModel?.endpoints.find((entry) => entry.protocol === protocol);
  if (!endpoint) return null;
  const apiKey = await registry.resolveSecret(namespace, connectionId);
  return apiKey ? { endpoint: endpoint.baseUrl, apiKey } : null;
}

/** Pi reads one models.json per surface. Its providers describe shared records, independent of the starting session. */
async function listPiCustomModelProviders(): Promise<PiCustomModelProvider[]> {
  const { endpoint: root } = await customModelForwarder(resolveCustomRoute);
  const boundModels = new Map<string, Set<string>>();
  for (const { config } of db.select({ config: sessions.config }).from(sessions).where(eq(sessions.provider, 'pi')).all()) {
    const ref = customModelRefFromOption(config?.model);
    if (!ref?.modelId) continue;
    const ids = boundModels.get(ref.connectionId) ?? new Set<string>();
    ids.add(ref.modelId);
    boundModels.set(ref.connectionId, ids);
  }
  const providers: PiCustomModelProvider[] = [];
  const records = await registry.listAccounts(namespace);
  for (const row of [...records].sort((a, b) => a.accountId.localeCompare(b.accountId))) {
    const meta = row.meta?.customModel;
    const bound = boundModels.get(row.accountId);
    if (!meta || (meta.removed && !bound)) continue;
    const endpoint = meta.endpoints.find(({ protocol }) => protocol === 'openai-responses')
      ?? meta.endpoints.find(({ protocol }) => protocol === 'openai-chat-completions');
    if (!endpoint || (endpoint.protocol !== 'openai-responses' && endpoint.protocol !== 'openai-chat-completions')) continue;
    const models = new Map(meta.models.map((model) => [model.id, model]));
    for (const id of bound ?? []) {
      if (!models.has(id)) models.set(id, { id });
    }
    if (models.size === 0) continue;
    providers.push({
      connectionId: row.accountId, name: row.meta?.displayName || row.accountId,
      baseUrl: customModelRoute(root, row.accountId, endpoint.protocol),
      protocol: endpoint.protocol, models: [...models.values()],
    });
  }
  return providers;
}

async function readSelectedCustomModel(providerId: string, ref: CustomModelRef, selection: 'new' | 'bound') {
  const row = await registry.getAccount(namespace, ref.connectionId);
  const meta = row?.meta?.customModel;
  if (!meta || (selection === 'new' && meta.removed)) throw new Error('The custom model no longer exists');
  const model = meta.models.find(({ id }) => id === ref.modelId);
  if (selection === 'new' && (ref.modelId ? !model : meta.models.length > 0)) {
    throw new Error('Select a model currently listed by this provider');
  }
  const apiKey = await registry.resolveSecret(namespace, ref.connectionId);
  const descriptor = pluginRegistry.get(providerId)?.capabilities.sessionBundle;
  const platform = descriptor?.platform;
  const nativeProtocol = providerId === 'antigravity' ? 'gemini-generate-content' : platform?.kind === 'supported' ? platform.wireProtocol : undefined;
  const matched = matchCustomModel({
    nativeProtocol, protocols: platform?.kind === 'supported' ? platform.protocols : undefined,
    connection: { endpoints: meta.endpoints, keySaved: Boolean(apiKey) },
    hasModel: Boolean(ref.modelId), allowDefaultModel: descriptor?.customModel?.modelOptional,
  });
  if (matched.reason) throw new Error(`Custom model unavailable: ${matched.reason}`);
  return { meta, name: row?.meta?.displayName || ref.connectionId, model, protocol: matched.endpoint.protocol };
}

/** Credential resolution runs only on the machine that will run this session. */
export async function validateCustomModelSelection(providerId: string, ref: CustomModelRef) {
  migrateCustomModelConnections();
  return (await readSelectedCustomModel(providerId, ref, 'new')).model;
}

export async function resolveCustomModel(providerId: string, sessionId: string, sourceSessionId?: string): Promise<ResolvedCustomModel | null> {
  migrateCustomModelConnections();
  const ref = customModelRefFromOption(db.select({ config: sessions.config }).from(sessions)
    .where(eq(sessions.id, sourceSessionId ?? sessionId)).get()?.config?.model);
  if (!ref) return null;
  const { meta, name, model, protocol } = await readSelectedCustomModel(providerId, ref, 'bound');
  const models = ref.modelId ? [ref.modelId, ...meta.models.map(({ id }) => id).filter((id) => id !== ref.modelId)] : [];
  const local = await customModelForwarder(resolveCustomRoute);
  return {
    connectionId: ref.connectionId, name,
    apiKey: local.apiKey, endpoint: customModelRoute(local.endpoint, ref.connectionId, protocol),
    models, protocol, capabilities: model, entries: meta.models,
  };
}

export async function resolveCustomModelLaunch(providerId: string, sessionId: string, sourceSessionId?: string) {
  const connection = await resolveCustomModel(providerId, sessionId, sourceSessionId);
  if (!connection) return null;
  return providerId === 'pi' ? { ...connection, piProviders: await listPiCustomModelProviders() } : connection;
}
