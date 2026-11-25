import { customModelForwarder, customModelRoute } from './custom-model-forwarder';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import {
  customModelEfforts, customModelRefFromOption, detectModelProtocol, matchCustomModel, normalizeModelBaseUrl,
  type CustomModelConnection, type CustomModelEffortResult, type CustomModelEntry, type CustomModelMeta, type CustomModelRef, type ModelProtocol, type PiCustomModelProvider,
} from '@gugu/session-core/models/custom-model';
import type { ConnectionModelList, CustomModelProtocolProbe, DetectCustomModelProtocols, SaveCustomModel, TestCustomModel } from '@gugu/session-core/workspace-server/agent-config';
import { providerAccountRegistry as registry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { loginShellEnv } from '@main/utils/userEnv';
import { migrateCustomModels } from './custom-model-migration';
import { describeDiscoveryIssues, discoverLocalConnections, discoveredSecret, discoveryIdentity, keyLast4, type DiscoveredConnection } from './local-connection-discovery';
import { nativeConfigRoot } from './native-config-root';
import { connectionProbeEnv } from './connection-endpoint-env';
import { listEndpointModels, probeEndpointProtocols, verifyEndpointModel } from './connection-endpoint-probe';
import { getCustomModelEffortResolver } from './platform-model-catalog-hook';

const namespace = 'models:custom';
const migratedDatabases = new WeakSet<object>();

export function migrateCustomModelConnections(): void {
  if (migratedDatabases.has(db)) return;
  const plugins = pluginRegistry.getAll();
  const vendors = new Set(plugins.filter((plugin) =>
    plugin.capabilities.auth.kind === 'supported' && plugin.capabilities.auth.vendorKey,
  ).map((plugin) => plugin.metadata.id));
  const defaults = new Map(plugins.flatMap(({ metadata, capabilities: { models } }) =>
    models.kind === 'selectable' && models.defaultModelId ? [[metadata.id, models.defaultModelId] as const] : []));
  const migrated = migrateCustomModels(db, vendors, defaults);
  if (migrated.length) log.info('custom-model migration: moved API connections', { migrated });
  migratedDatabases.add(db);
}

type StoredRow = NonNullable<Awaited<ReturnType<typeof registry.getAccount>>>;
const unavailable: CustomModelEffortResult = { kind: 'unavailable' };
const effortFactsCache = new Map<string, { until: number; value: CustomModelEffortResult }>();

async function modelEffortFacts(ids: readonly string[]): Promise<Map<string, CustomModelEffortResult>> {
  const resolve = getCustomModelEffortResolver();
  const now = Date.now();
  const unique = [...new Set(ids)];
  const facts = new Map<string, CustomModelEffortResult>();
  const missing = unique.filter((id) => {
    const cached = effortFactsCache.get(id);
    if (!cached || cached.until <= now) return true;
    facts.set(id, cached.value);
    return false;
  });
  if (resolve) {
    for (let from = 0; from < missing.length; from += 200) {
      const batch = missing.slice(from, from + 200);
      const results = await resolve(batch).catch(() => new Map<string, CustomModelEffortResult>());
      for (const id of batch) {
        const value = results.get(id) ?? unavailable;
        facts.set(id, value);
        effortFactsCache.set(id, { value, until: Date.now() + (value.kind === 'unavailable' ? 5_000 : 30_000) });
      }
    }
  }
  if (effortFactsCache.size > 2000) {
    for (const id of effortFactsCache.keys()) {
      if (effortFactsCache.size <= 2000) break;
      effortFactsCache.delete(id);
    }
  }
  return facts;
}

export async function lookupCustomModelEfforts(ids: readonly string[]) {
  const facts = await modelEffortFacts(ids);
  return [...new Set(ids)].map(id => ({ id, result: facts.get(id) ?? unavailable }));
}

async function enrichModelEntries(entries: readonly CustomModelEntry[]): Promise<CustomModelEntry[]> {
  const facts = await modelEffortFacts(entries.flatMap(({ id, modelsDevId }) => modelsDevId ? [id, modelsDevId] : [id]));
  return entries.map((entry) => {
    const direct = facts.get(entry.id) ?? unavailable;
    const chosen = entry.modelsDevId ? facts.get(entry.modelsDevId) : undefined;
    return { ...entry, effortCatalog: direct.kind === 'found' ? direct : chosen ?? direct };
  });
}

/** What a renderer may read of a stored connection: never the key, never the discovery identity. */
function viewRow(row: StoredRow, keySaved: boolean): CustomModelConnection {
  const { discovery, ...meta } = row.meta!.customModel!;
  return {
    id: row.accountId, name: row.meta?.displayName || row.accountId, credentialRef: row.credentialRef, keySaved, ...meta,
    ...(discovery ? { discovered: { source: discovery.source, keyLast4: discovery.keyLast4 } } : {}),
  };
}

async function view(id: string): Promise<CustomModelConnection> {
  const row = await registry.getAccount(namespace, id);
  if (!row?.meta?.customModel) throw new Error('The custom model no longer exists');
  const connection = viewRow(row, Boolean(await registry.resolveSecret(namespace, id)));
  return { ...connection, models: await enrichModelEntries(connection.models) };
}

let loggedDiscoveryIssues = '';
/** Connections this machine already has configured elsewhere, read-only. A broken source yields fewer candidates, never an error. */
async function scanLocal(): Promise<DiscoveredConnection[]> {
  try {
    const env = { ...process.env, ...loginShellEnv() };
    const { connections, issues } = await discoverLocalConnections({ root: nativeConfigRoot('codex', env), env });
    const signature = describeDiscoveryIssues(issues);
    if (signature !== loggedDiscoveryIssues) {
      loggedDiscoveryIssues = signature;
      if (signature) log.warn(`[custom-models] some existing connections on this machine could not be listed: ${signature}`);
    }
    return connections;
  } catch (error) {
    log.warn('[custom-models] scanning the existing connections on this machine failed', { error: error instanceof Error ? error.name : 'unknown' });
    return [];
  }
}

/**
 * The discovered connections nobody has stored yet. A stored connection hides its candidate when it is that candidate's
 * own record (removed ones included, so a removal sticks) or when it has the same address and key.
 */
async function unstoredCandidates(rows: StoredRow[], secretOf: (id: string) => Promise<string | null>): Promise<DiscoveredConnection[]> {
  const candidates = await scanLocal();
  if (candidates.length === 0) return [];
  const taken = new Set<string>();
  await Promise.all(rows.map(async (row) => {
    const meta = row.meta?.customModel;
    if (!meta) return;
    if (meta.discovery) taken.add(meta.discovery.identity);
    for (const identity of meta.suppresses ?? []) taken.add(identity);
    if (!meta.discovery) {
      const key = await secretOf(row.accountId);
      if (key) for (const { baseUrl } of meta.endpoints) taken.add(discoveryIdentity(baseUrl, key));
    }
  }));
  return Promise.all(candidates.filter(({ identity }) => !taken.has(identity)).map(withProbedEndpoints));
}

const discoveredProbes = new Map<string, Promise<CustomModelMeta['endpoints']>>();
const PROBE_WAIT_MS = 2_000;

/**
 * A config file names one protocol for an address that often answers several, so a discovered custom address is probed
 * the same way a typed one is: once per run, waited for briefly; a slower answer is used from the next read on.
 */
async function withProbedEndpoints(candidate: DiscoveredConnection): Promise<DiscoveredConnection> {
  const key = discoveredSecret(candidate);
  const baseUrl = candidate.endpoints[0]?.baseUrl;
  if (candidate.preset || !key || !baseUrl) return candidate;
  let probe = discoveredProbes.get(candidate.identity);
  if (!probe) {
    probe = detectCustomModelProtocols({ baseUrl, apiKey: key, modelId: candidate.models[0]?.id }).then(({ endpoints }) => endpoints, () => []);
    discoveredProbes.set(candidate.identity, probe);
  }
  const endpoints = await Promise.race([probe, new Promise<[]>((resolve) => setTimeout(() => resolve([]), PROBE_WAIT_MS))]);
  // The secret is keyed by this object, so the probed protocols are written onto it rather than a copy.
  if (endpoints.length) candidate.endpoints = endpoints;
  return candidate;
}

function candidateView(candidate: DiscoveredConnection): CustomModelConnection {
  return {
    id: candidate.id, name: candidate.name, credentialRef: '', keySaved: true, preset: candidate.preset,
    endpoints: candidate.endpoints, models: candidate.models, discovered: { source: candidate.source, keyLast4: candidate.keyLast4 },
  };
}

function secretReader(): (id: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (id) => cache.get(id) ?? cache.set(id, registry.resolveSecret(namespace, id)).get(id)!;
}

const materializing = new Map<string, Promise<void>>();

/**
 * First use of a discovered connection: store it under the id it was listed with. Nothing happens for an id that is
 * already stored (including a removed one), and an id whose source changed since it was listed is left unstored, so
 * it can never be pointed at another key. Concurrent first uses share one write.
 */
function ensureStored(id: string, options: { keepKey: boolean } = { keepKey: true }): Promise<void> {
  const inflight = materializing.get(id);
  if (inflight) return inflight;
  const work = (async () => {
    if (await registry.getAccount(namespace, id)) return;
    const rows = await registry.listAccounts(namespace);
    const candidate = (await unstoredCandidates(rows, secretReader())).find((entry) => entry.id === id);
    const key = candidate && discoveredSecret(candidate);
    if (!candidate || !key) return;
    await registry.upsertAccount({
      providerId: namespace, accountId: id, ...(options.keepKey ? { secret: key } : { electDefault: false }),
      meta: { displayName: candidate.name, customModel: {
        preset: candidate.preset, endpoints: candidate.endpoints, models: candidate.models,
        discovery: { source: candidate.source, identity: candidate.identity, keyLast4: candidate.keyLast4, ...(candidate.aliases.length ? { aliases: candidate.aliases } : {}) },
      } },
    });
  })().finally(() => { materializing.delete(id); });
  materializing.set(id, work);
  return work;
}

export async function listCustomModels(): Promise<CustomModelConnection[]> {
  migrateCustomModelConnections();
  const rows = await registry.listAccounts(namespace);
  const secretOf = secretReader();
  const stored = await Promise.all(rows.filter((row) => row.meta?.customModel && !row.meta.customModel.removed)
    .map(async (row) => viewRow(row, Boolean(await secretOf(row.accountId)))));
  const connections = [...stored, ...(await unstoredCandidates(rows, secretOf)).map(candidateView)];
  const models = await enrichModelEntries(connections.flatMap((connection) => connection.models));
  let offset = 0;
  return connections.map((connection) => {
    const enriched = { ...connection, models: models.slice(offset, offset + connection.models.length) };
    offset += connection.models.length;
    return enriched;
  });
}

export async function saveCustomModel(input: SaveCustomModel): Promise<CustomModelConnection> {
  migrateCustomModelConnections();
  const id = input.id ?? randomUUID();
  if (input.id) await ensureStored(input.id);
  const existing = input.id ? await registry.getAccount(namespace, input.id) : null;
  if (input.id && (!existing?.meta?.customModel || existing.meta.customModel.removed)) throw new Error('The custom model no longer exists');
  if (!input.apiKey && !(existing && await registry.resolveSecret(namespace, id))) throw new Error('An API key is required on this device');
  // Editing keeps where the connection came from: its identity is what stops the same source being listed again.
  const discovery = existing?.meta?.customModel?.discovery;
  await registry.upsertAccount({
    providerId: namespace, accountId: id,
    ...(input.apiKey ? { secret: input.apiKey } : {}),
    meta: {
      displayName: input.name,
      customModel: {
        preset: input.preset, endpoints: input.endpoints, models: input.models,
        ...(input.routes ? { routes: input.routes } : {}),
        ...(input.harnessProtocols && Object.keys(input.harnessProtocols).length ? { harnessProtocols: input.harnessProtocols } : {}),
        ...(discovery ? { discovery: input.apiKey ? { ...discovery, keyLast4: keyLast4(input.apiKey) } : discovery } : {}),
      },
    },
  });
  return view(id);
}

/** The row stays as a removal record (bound sessions and discovery read it); the key does not. Sessions bound to it stop at "unavailable". */
export async function removeCustomModel(connectionId: string): Promise<void> {
  // A connection nobody has used is removed without ever keeping its key; only the removal is recorded.
  await ensureStored(connectionId, { keepKey: false });
  const row = await registry.getAccount(namespace, connectionId);
  if (!row?.meta?.customModel) throw new Error('The custom model no longer exists');
  const meta = row.meta.customModel;
  const key = await registry.resolveSecret(namespace, connectionId);
  const suppresses = key ? rememberedIdentities(meta, key) : meta.suppresses;
  await registry.retireAccount(namespace, connectionId, { ...row.meta, customModel: { ...meta, removed: true, ...(suppresses?.length ? { suppresses } : {}) } });
}

/** What discovery recognises a key by at each of the connection's addresses. Never the key. */
function rememberedIdentities(meta: { endpoints: { baseUrl: string }[]; suppresses?: string[] }, key: string): string[] {
  return [...new Set([...(meta.suppresses ?? []), ...meta.endpoints.map(({ baseUrl }) => discoveryIdentity(baseUrl, key))])];
}

/**
 * Removal records written before removal dropped the key still hold it (#3428). Remember what the key was to discovery
 * (its identity), then drop it, so a connection removed earlier neither keeps a key nor comes back in the list. A key
 * that cannot be read is dropped all the same; the record then only loses the memory of what it held.
 */
export async function dropRemovedConnectionKeys(): Promise<void> {
  for (const row of await registry.listAccounts(namespace)) {
    const meta = row.meta?.customModel;
    if (!meta?.removed) continue;
    try {
      const key = await registry.resolveSecret(namespace, row.accountId);
      if (key) await registry.retireAccount(namespace, row.accountId, { ...row.meta, customModel: { ...meta, suppresses: rememberedIdentities(meta, key) } });
    } catch (error) {
      log.warn('[custom-models] could not remember a removed connection before dropping its key', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  await registry.dropRetiredSecrets();
}

/** Where a connection goes and the key it reads with on this machine: its stored record, or a discovered one not stored yet. */
async function heldConnection(connectionId: string): Promise<{ endpoints: CustomModelMeta['endpoints']; key: string | undefined }> {
  const row = await registry.getAccount(namespace, connectionId);
  if (row?.meta?.customModel) return { endpoints: row.meta.customModel.endpoints, key: (await registry.resolveSecret(namespace, connectionId)) ?? undefined };
  // Trying or showing a discovered connection is not using it: its key is read for this request and nothing is stored.
  const candidate = (await unstoredCandidates(await registry.listAccounts(namespace), secretReader())).find(({ id }) => id === connectionId);
  if (!candidate) throw new Error('The custom model no longer exists');
  return { endpoints: candidate.endpoints, key: discoveredSecret(candidate) };
}

/** The whole key, for this computer's own window to show (see `CUSTOM_MODEL_KEY_CHANNEL`). */
export async function readCustomModelKey(connectionId: string): Promise<string> {
  const { key } = await heldConnection(connectionId);
  if (!key) throw new Error('The model’s API key is unavailable on this device');
  return key;
}

export async function testCustomModel(input: TestCustomModel): Promise<ConnectionModelList> {
  let endpoints = input.endpoints;
  let key = input.apiKey;
  if (input.connectionId) {
    const held = await heldConnection(input.connectionId);
    endpoints ??= held.endpoints;
    key ??= held.key;
  }
  if (!key) throw new Error('The model’s API key is unavailable on this device');
  const endpoint = endpoints?.find(({ protocol }) => protocol.startsWith('openai-')) ?? endpoints?.[0];
  if (!endpoint) throw new Error('An API address is required');
  const target = { endpoint: endpoint.baseUrl, apiKey: key, protocol: endpoint.protocol, env: connectionProbeEnv() };
  const result = await listEndpointModels(target);
  return input.modelId && result.kind === 'unlisted' && result.reason === 'no-list'
    ? verifyEndpointModel(target, input.modelId)
    : result;
}

/** Probes an address for the protocols it answers, with a typed key or the one a saved connection holds; runs on the machine whose key it is. */
export async function detectCustomModelProtocols(input: DetectCustomModelProtocols): Promise<CustomModelProtocolProbe> {
  const apiKey = input.apiKey ?? (input.connectionId ? (await heldConnection(input.connectionId)).key : undefined);
  if (!apiKey) throw new Error('The model’s API key is unavailable on this device');
  const probe = await probeEndpointProtocols({
    baseUrl: normalizeModelBaseUrl(input.baseUrl), apiKey, modelId: input.modelId, hint: detectModelProtocol(input.baseUrl), env: connectionProbeEnv(),
  });
  return { ...probe, endpoints: probe.endpoints.map((endpoint) => ({ ...endpoint, baseUrl: normalizeModelBaseUrl(endpoint.baseUrl) })) };
}

export type ResolvedCustomModel = {
  connectionId: string;
  name: string;
  endpoint: string;
  apiKey: string;
  models: string[];
  protocol: ModelProtocol;
  capabilities?: CustomModelEntry;
  entries: CustomModelEntry[];
  upstreamEndpoint: string;
  routeId?: string;
  removed?: boolean;
  /** The session's recorded reasoning level. */
  effort?: string;
};

async function resolveCustomRoute(connectionId: string, protocol: ModelProtocol, routeId?: string) {
  const row = await registry.getAccount(namespace, connectionId);
  const meta = row?.meta?.customModel;
  const route = meta?.routes?.find(({ id, outgoing }) => id === routeId && outgoing === protocol);
  if (routeId && !route) return null;
  const endpoint = route?.baseUrl ?? meta?.endpoints.find((entry) => entry.protocol === protocol)?.baseUrl;
  if (!endpoint) return null;
  const apiKey = await registry.resolveSecret(namespace, connectionId);
  return apiKey ? { endpoint, apiKey } : null;
}

function matchForHarness(providerId: string, connection: CustomModelMeta & { keySaved: boolean }, modelId?: string) {
  const descriptor = pluginRegistry.get(providerId)?.capabilities.sessionBundle;
  const platform = descriptor?.platform;
  const nativeProtocol = providerId === 'antigravity' ? 'gemini-generate-content' : platform?.kind === 'supported' ? platform.wireProtocol : undefined;
  return {
    nativeProtocol,
    matched: matchCustomModel({
      harness: providerId, nativeProtocol, protocols: platform?.kind === 'supported' ? platform.protocols : undefined,
      convertFrom: descriptor?.customModel?.convertFrom,
      connection, modelId, hasModel: Boolean(modelId), allowDefaultModel: descriptor?.customModel?.modelOptional,
    }),
  };
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
    if (!meta || (meta.removed && !bound) || !await registry.resolveSecret(namespace, row.accountId)) continue;
    const models = new Map(meta.models.map((model) => [model.id, model]));
    for (const id of bound ?? []) {
      if (!models.has(id)) models.set(id, { id });
    }
    const byRoute = new Map<string, PiCustomModelProvider & { models: CustomModelEntry[] }>();
    for (const model of models.values()) {
      const { matched } = matchForHarness('pi', { ...meta, keySaved: true }, model.id);
      const protocol = matched.endpoint?.protocol;
      if (protocol !== 'openai-responses' && protocol !== 'openai-chat-completions') continue;
      const key = matched.routeId ?? protocol;
      let provider = byRoute.get(key);
      if (!provider) {
        provider = {
          connectionId: row.accountId, routeId: matched.routeId, name: row.meta?.displayName || row.accountId,
          baseUrl: customModelRoute(root, row.accountId, protocol, matched.routeId),
          protocol, models: [],
        };
        byRoute.set(key, provider);
      }
      provider.models.push(model);
    }
    providers.push(...byRoute.values());
  }
  return providers;
}

async function readSelectedCustomModel(providerId: string, ref: CustomModelRef, selection: 'new' | 'bound') {
  await ensureStored(ref.connectionId);
  const row = await registry.getAccount(namespace, ref.connectionId);
  const meta = row?.meta?.customModel;
  if (!meta || (selection === 'new' && meta.removed)) throw new Error('The custom model no longer exists');
  const model = meta.models.find(({ id }) => id === ref.modelId);
  if (selection === 'new' && (ref.modelId ? !model : meta.models.length > 0)) {
    throw new Error('Select a model currently listed by this provider');
  }
  const apiKey = await registry.resolveSecret(namespace, ref.connectionId);
  const { matched, nativeProtocol } = matchForHarness(providerId, { ...meta, keySaved: Boolean(apiKey) }, ref.modelId);
  if (matched.reason) throw new Error(`Custom model unavailable: ${matched.reason}`);
  return {
    meta, name: row?.meta?.displayName || ref.connectionId, model, endpoint: matched.endpoint, routeId: matched.routeId,
    // A converted record reaches the harness in its own wire protocol, through the bundled router.
    harnessProtocol: matched.converted ? nativeProtocol : undefined,
  };
}

/** Credential resolution runs only on the machine that will run this session. */
export async function validateCustomModelSelection(providerId: string, ref: CustomModelRef) {
  migrateCustomModelConnections();
  const { model } = await readSelectedCustomModel(providerId, ref, 'new');
  return model && (await enrichModelEntries([model]))[0];
}

export async function selectedCustomModelEndpoint(providerId: string, ref: CustomModelRef): Promise<string> {
  migrateCustomModelConnections();
  return (await readSelectedCustomModel(providerId, ref, 'new')).endpoint.baseUrl;
}

export async function customModelArmedEffort(providerId: string, ref: CustomModelRef | undefined, effort: string | undefined) {
  if (!effort) return undefined;
  if (!ref) return effort;
  if (!ref.modelId) return undefined;
  const row = await registry.getAccount(namespace, ref.connectionId);
  const entry = row?.meta?.customModel?.models.find(({ id }) => id === ref.modelId) ?? { id: ref.modelId };
  const [entryWithCatalog] = await enrichModelEntries([entry]);
  return customModelEfforts(entryWithCatalog, pluginRegistry.get(providerId)?.capabilities.effort)?.includes(effort) ? effort : undefined;
}

export async function resolveCustomModel(providerId: string, sessionId: string, sourceSessionId?: string): Promise<ResolvedCustomModel | null> {
  migrateCustomModelConnections();
  const config = db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sourceSessionId ?? sessionId)).get()?.config;
  const ref = customModelRefFromOption(config?.model);
  if (!ref) return null;
  const selected = await readSelectedCustomModel(providerId, ref, 'bound');
  const { meta, name, model, endpoint: upstream, routeId } = selected;
  const { protocol } = upstream;
  const routedEntries = meta.models.filter(({ id }) => {
    const { matched } = matchForHarness(providerId, { ...meta, keySaved: true }, id);
    return matched.endpoint?.protocol === protocol && matched.routeId === routeId;
  });
  const entries = await enrichModelEntries(model || !ref.modelId || routedEntries.some(({ id }) => id === ref.modelId)
    ? routedEntries : [{ id: ref.modelId }, ...routedEntries]);
  const selectedEntry = entries.find(({ id }) => id === ref.modelId);
  const models = ref.modelId ? [ref.modelId, ...entries.map(({ id }) => id).filter((id) => id !== ref.modelId)] : [];
  const local = await customModelForwarder(resolveCustomRoute);
  const route = customModelRoute(local.endpoint, ref.connectionId, protocol, routeId);
  // The router speaks the harness's protocol on loopback and calls the forwarder route in the record's protocol.
  const endpoint = selected.harnessProtocol
    ? await (await import('./conversion-routers')).convertedBaseUrl(providerId, `${ref.connectionId}-${routeId ?? protocol}`, route, local.apiKey)
    : route;
  return {
    connectionId: ref.connectionId, name,
    apiKey: local.apiKey, endpoint,
    models, protocol: selected.harnessProtocol ?? protocol, capabilities: selectedEntry, entries, routeId,
    upstreamEndpoint: upstream.baseUrl, removed: meta.removed,
    ...(config?.effort && customModelEfforts(selectedEntry, pluginRegistry.get(providerId)?.capabilities.effort)?.includes(config.effort) ? { effort: config.effort } : {}),
  };
}

export async function resolveCustomModelLaunch(providerId: string, sessionId: string, sourceSessionId?: string) {
  const connection = await resolveCustomModel(providerId, sessionId, sourceSessionId);
  if (!connection) return null;
  return providerId === 'pi' ? { ...connection, piProviders: await listPiCustomModelProviders() } : connection;
}
