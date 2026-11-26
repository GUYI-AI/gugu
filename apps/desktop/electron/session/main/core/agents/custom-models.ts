import { customModelForwarder, customModelRoute, customModelSessionKey } from './custom-model-forwarder';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import {
  FAST_PROTOCOLS, customModelApiUrl, customModelMetaSchema, customModelEfforts, customModelRefFromOption, detectModelProtocol, matchCustomModel, normalizeModelBaseUrl,
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
  if (!getCustomModelEffortResolver()) return [...entries];
  const facts = await modelEffortFacts(entries.flatMap(({ id, modelsDevId }) => modelsDevId ? [id, modelsDevId] : [id]));
  return entries.map((entry) => {
    const direct = facts.get(entry.id) ?? unavailable;
    const chosen = entry.modelsDevId ? facts.get(entry.modelsDevId) : undefined;
    return { ...entry, effortCatalog: direct.kind === 'found' ? direct : chosen ?? direct };
  });
}

/** What a renderer may read of a stored connection: never the key, never the discovery identity. */
function viewRow(row: StoredRow, key: string | null): CustomModelConnection {
  const { discovery, mergedInto: _mergedInto, suppresses: _suppresses, ...meta } = row.meta!.customModel!;
  return {
    id: row.accountId, name: row.meta?.displayName || row.accountId, credentialRef: row.credentialRef, keySaved: Boolean(key), ...meta,
    ...(key ? { keyLast4: keyLast4(key) } : {}),
    ...(discovery ? { discovered: { source: discovery.source, keyLast4: discovery.keyLast4 } } : {}),
  };
}

async function view(id: string): Promise<CustomModelConnection> {
  const row = await registry.getAccount(namespace, id);
  if (!row?.meta?.customModel) throw new Error('The custom model no longer exists');
  const connection = viewRow(row, await registry.resolveSecret(namespace, id));
  return { ...connection, models: await enrichModelEntries(connection.models) };
}

let loggedDiscoveryIssues = '';
/** Connections this machine already has configured elsewhere, read-only. A broken source yields fewer candidates, never an error. */
async function scanLocal(): Promise<DiscoveredConnection[]> {
  try {
    const env = { ...process.env, ...loginShellEnv() };
    const { connections, issues } = await discoverLocalConnections({ root: nativeConfigRoot('codex', env), claudeRoot: nativeConfigRoot('claude', env), env });
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
async function unstoredCandidates(rows: StoredRow[], secretOf: (id: string) => Promise<string | null>, candidates?: DiscoveredConnection[]): Promise<DiscoveredConnection[]> {
  candidates ??= await scanLocal();
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
  return candidates.filter(candidate => !taken.has(candidate.identity));
}

const discoveredProbes = new Map<string, Promise<CustomModelMeta['endpoints']>>();
const PROBE_WAIT_MS = 2_000;

/**
 * A config file names one protocol for an address that often answers several, so a discovered custom address is probed
 * the same way a typed one is: once per run, waited for briefly; a slower answer is used from the next read on.
 */
async function withProbedEndpoints(candidate: DiscoveredConnection): Promise<CustomModelMeta['endpoints']> {
  const key = discoveredSecret(candidate);
  const baseUrl = candidate.endpoints[0]?.baseUrl;
  if (candidate.preset || !key || !baseUrl) return candidate.endpoints;
  let probe = discoveredProbes.get(candidate.identity);
  if (!probe) {
    probe = detectCustomModelProtocols({ baseUrl, apiKey: key, modelId: candidate.models[0]?.id }).then(({ endpoints }) => endpoints, () => []);
    discoveredProbes.set(candidate.identity, probe);
  }
  const endpoints = await Promise.race([probe, new Promise<[]>((resolve) => setTimeout(() => resolve([]), PROBE_WAIT_MS))]);
  return endpoints.length ? endpoints : candidate.endpoints;
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

let writes = Promise.resolve();

function serializeCustomModelWrite<T>(work: () => Promise<T>): Promise<T> {
  const result = writes.then(work);
  writes = result.then(() => undefined, () => undefined);
  return result;
}

function isActive(row: StoredRow): boolean {
  const meta = row.meta?.customModel;
  return Boolean(meta && !meta.removed && !meta.mergedInto);
}

async function readConnectionSecret(id: string): Promise<string | null> {
  const visited = new Set<string>();
  let current = id;
  while (!visited.has(current)) {
    visited.add(current);
    const meta = (await registry.getAccount(namespace, current))?.meta?.customModel;
    if (!meta || meta.removed) return null;
    if (!meta.mergedInto) return registry.resolveSecret(namespace, current);
    current = meta.mergedInto;
  }
  return null;
}

function combineModels(existing: CustomModelMeta['models'], added: CustomModelMeta['models']): CustomModelMeta['models'] {
  const models = new Map(existing.map(model => [model.id, model]));
  for (const model of added) if (!models.has(model.id)) models.set(model.id, model);
  return [...models.values()];
}

/**
 * First use of a discovered connection: store it under the id it was listed with. Nothing happens for an id that is
 * already stored (including a removed one), and an id whose source changed since it was listed is left unstored, so
 * it can never be pointed at another key. Concurrent first uses share one write.
 */
async function ensureStored(id: string, options: { keepKey: boolean } = { keepKey: true }): Promise<void> {
  if (await registry.getAccount(namespace, id)) return;
  const rows = await registry.listAccounts(namespace);
  const pending = await unstoredCandidates(rows, secretReader());
  const candidate = pending.find(entry => entry.id === id);
  if (!candidate) return;
  await storeDiscovered(candidate, options.keepKey);
}

async function storeDiscovered(candidate: DiscoveredConnection, keepKey: boolean): Promise<void> {
  const apiUrl = customModelApiUrl(candidate);
  const endpoints = await withProbedEndpoints(candidate);
  const key = discoveredSecret(candidate);
  if (!key) throw new Error('The discovered API key is unavailable');
  await registry.upsertAccount({
    providerId: namespace, accountId: candidate.id, ...(keepKey ? { secret: key } : { electDefault: false }),
    meta: { displayName: candidate.name, customModel: {
      apiUrl, preset: candidate.preset, endpoints, models: candidate.models,
      discovery: { source: candidate.source, identity: candidate.identity, keyLast4: candidate.keyLast4, ...(candidate.aliases.length ? { aliases: candidate.aliases } : {}) },
    } },
  });
}

async function importHarnessConnections(candidates: DiscoveredConnection[]): Promise<void> {
  const rows = await registry.listAccounts(namespace);
  const secretOf = secretReader();
  const pending = await unstoredCandidates(rows, secretOf, candidates);
  const active = rows.filter(isActive);
  for (const candidate of candidates) {
    const url = customModelApiUrl(candidate);
    const atUrl = active.filter(row => customModelApiUrl(row.meta!.customModel!) === url);
    const row = atUrl.find(entry => entry.accountId === candidate.id) ??
      (await Promise.all(atUrl.map(async entry => (await secretOf(entry.accountId)) === discoveredSecret(candidate) ? entry : null))).find(Boolean);
    if (row && (await secretOf(row.accountId)) === discoveredSecret(candidate)) {
      const meta = row.meta!.customModel!;
      // A previously learned model is recorded even when the user later removes it from the enabled list.
      const learned = meta.discovery?.identity === candidate.identity;
      if (learned) continue;
      const disabled = new Set(meta.disabledModels?.map(model => model.id));
      const models = combineModels(meta.models, candidate.models.filter(model => !disabled.has(model.id)));
      const endpoints = [...meta.endpoints, ...candidate.endpoints.filter(endpoint => !meta.endpoints.some(current => current.protocol === endpoint.protocol))];
      await registry.upsertAccount({ providerId: namespace, accountId: row.accountId, meta: { ...row.meta,
        customModel: { ...meta, preset: meta.preset ?? candidate.preset, apiUrl: url, endpoints, models, discovery: {
          identity: candidate.identity, source: candidate.source, keyLast4: candidate.keyLast4, aliases: candidate.aliases,
        } },
      } });
    } else if (pending.includes(candidate)) {
      await storeDiscovered(candidate, true);
    }
  }
}

export async function listCustomModels(): Promise<CustomModelConnection[]> {
  migrateCustomModelConnections();
  return serializeCustomModelWrite(async () => {
    const candidates = await scanLocal();
    await importHarnessConnections(candidates);
    const rows = await registry.listAccounts(namespace);
    const secretOf = secretReader();
    const nativeHarnesses = await Promise.all((['claude', 'codex'] as const).map(async harness => {
      const selected = await registry.getDefaultAccountId(`harness:${harness}`);
      return !selected || selected === 'native' ? harness : null;
    }));
    const stored = await Promise.all(rows.filter(isActive).map(async row => viewRow(row, await secretOf(row.accountId))));
    const pending = (await unstoredCandidates(rows, secretOf, candidates)).map(candidateView);
    return Promise.all([...stored, ...pending].map(async connection => {
      const url = customModelApiUrl(connection);
      const managedNativeHarnesses = nativeHarnesses.filter((harness): harness is "claude" | "codex" => harness !== null && candidates.some(candidate =>
        candidate.nativeHarnesses?.includes(harness) && customModelApiUrl(candidate) === url));
      return { ...connection, models: await enrichModelEntries(connection.models), ...(managedNativeHarnesses.length ? { managedNativeHarnesses } : {}) };
    }));
  });
}

/**
 * A save writes exactly one configuration: the one it names, or a new one. Configurations never merge, not even at the
 * same address with the same key (owner 11-26 23:26, confirmed 11-27 00:16): each carries its own capabilities.
 */
export function saveCustomModel(input: SaveCustomModel): Promise<CustomModelConnection> {
  return serializeCustomModelWrite(async () => {
    migrateCustomModelConnections();
    const apiUrl = customModelApiUrl(input);
    let existing: StoredRow | null = null;
    if (input.id) {
      await ensureStored(input.id);
      existing = await registry.getAccount(namespace, input.id);
      if (!existing || !isActive(existing)) throw new Error('The custom model no longer exists');
      // Rows merged by builds before 11-27 still point here and resolve their sessions through this address.
      if (apiUrl !== customModelApiUrl(existing.meta!.customModel!) &&
        (await registry.listAccounts(namespace)).some(row => row.meta?.customModel?.mergedInto === existing!.accountId)) {
        throw new Error('Add a new connection to change this API address. Existing sessions still use this address.');
      }
    }
    const id = existing?.accountId ?? randomUUID();
    const prior = existing?.meta?.customModel;
    if (!input.apiKey && !(existing && await registry.resolveSecret(namespace, id))) throw new Error('An API key is required on this device');
    const meta = customModelMetaSchema.parse({ apiUrl, preset: input.preset, endpoints: input.endpoints, models: input.models,
      routes: input.routes ?? prior?.routes, harnessProtocols: input.harnessProtocols ?? prior?.harnessProtocols,
      // A save that does not say (switching a model on or off, keeping a key) keeps what the last check found.
      unverified: (input.unverified ?? prior?.unverified) || undefined,
      disabledModels: (input.disabledModels ?? prior?.disabledModels)?.filter(entry => !input.models.some(model => model.id === entry.id)) });
    const discovery = prior?.discovery;
    await registry.upsertAccount({ providerId: namespace, accountId: id, ...(input.apiKey ? { secret: input.apiKey } : {}), meta: {
      displayName: input.name,
      customModel: { ...prior, ...meta, ...(discovery && input.apiKey ? { discovery: { ...discovery, keyLast4: keyLast4(input.apiKey) } } : {}) },
    } });
    return view(id);
  });
}

/** The row stays as a removal record (bound sessions and discovery read it); the key does not. Sessions bound to it stop at "unavailable". */
export function removeCustomModel(connectionId: string): Promise<void> {
  return serializeCustomModelWrite(() => removeSavedCustomModel(connectionId));
}

async function removeSavedCustomModel(connectionId: string): Promise<void> {
  // A connection nobody has used is removed without ever keeping its key; only the removal is recorded.
  await ensureStored(connectionId, { keepKey: false });
  const row = await registry.getAccount(namespace, connectionId);
  if (!row?.meta?.customModel || !isActive(row)) throw new Error('The custom model no longer exists');
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
  if (row?.meta?.customModel) return { endpoints: row.meta.customModel.endpoints, key: (await readConnectionSecret(connectionId)) ?? undefined };
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
  const normalized = (endpoints: CustomModelMeta['endpoints']) => endpoints.map((endpoint) => ({ ...endpoint, baseUrl: normalizeModelBaseUrl(endpoint.baseUrl) }));
  return { ...probe, endpoints: normalized(probe.endpoints), ...(probe.refused ? { refused: normalized(probe.refused) } : {}) };
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

async function resolveCustomRoute(connectionId: string, protocol: ModelProtocol, routeId?: string, sessionId?: string) {
  const row = await registry.getAccount(namespace, connectionId);
  const meta = row?.meta?.customModel;
  const route = meta?.routes?.find(({ id, outgoing }) => id === routeId && outgoing === protocol);
  if (routeId && !route) return null;
  const endpoint = route?.baseUrl ?? meta?.endpoints.find((entry) => entry.protocol === protocol)?.baseUrl;
  if (!endpoint) return null;
  const apiKey = await readConnectionSecret(connectionId);
  if (!apiKey) return null;
  return { endpoint, apiKey, ...(sessionId && meta && FAST_PROTOCOLS.includes(protocol) && sessionAsksFast(sessionId, connectionId, meta) ? { priority: true } : {}) };
}

/**
 * Read on every request, so turning Fast off (or switching to a model that does not declare it) applies to the next one.
 * The session's Fast choice counts only while its current model is on this connection and declares Fast.
 */
function sessionAsksFast(sessionId: string, connectionId: string, meta: CustomModelMeta): boolean {
  const config = db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).get()?.config;
  if (config?.fastMode !== true) return false;
  const ref = customModelRefFromOption(config.model);
  return ref?.connectionId === connectionId && meta.models.some(({ id, fast }) => id === ref.modelId && fast === true);
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
    if (!meta || ((meta.removed || meta.mergedInto) && !bound) || !await readConnectionSecret(row.accountId)) continue;
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
  await serializeCustomModelWrite(() => ensureStored(ref.connectionId));
  const row = await registry.getAccount(namespace, ref.connectionId);
  const meta = row?.meta?.customModel;
  if (!meta || (selection === 'new' && (meta.removed || meta.mergedInto))) throw new Error('The custom model no longer exists');
  const enabledModel = meta.models.find(({ id }) => id === ref.modelId);
  const model = enabledModel ?? (selection === 'bound' ? meta.disabledModels?.find(({ id }) => id === ref.modelId) : undefined);
  if (selection === 'new' && (ref.modelId ? !enabledModel : meta.models.length > 0 || Boolean(meta.disabledModels?.length))) {
    throw new Error('Select a model currently listed by this provider');
  }
  const apiKey = await readConnectionSecret(ref.connectionId);
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

export async function customModelArmedEffort(providerId: string, ref: CustomModelRef, effort: string) {
  if (!ref.modelId) return undefined;
  const row = await registry.getAccount(namespace, ref.connectionId);
  const entry = row?.meta?.customModel?.models.find(({ id }) => id === ref.modelId) ?? { id: ref.modelId };
  const [entryWithCatalog] = await enrichModelEntries([entry]);
  return customModelEfforts(entryWithCatalog, pluginRegistry.get(providerId)?.capabilities.effort)?.includes(effort) ? effort : undefined;
}

/** Whether a new session on this custom model may start with Fast: the same rule the composer offers it by. */
export async function customModelFastAllowed(providerId: string, ref: CustomModelRef): Promise<boolean> {
  const selected = await readSelectedCustomModel(providerId, ref, 'new');
  return selected.model?.fast === true && !selected.harnessProtocol && FAST_PROTOCOLS.includes(selected.endpoint.protocol);
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
  // A session's own key lets the forwarder find its Fast choice; a converted route is pooled per record and keeps the shared key.
  const apiKey = selected.harnessProtocol ? local.apiKey : await customModelSessionKey(resolveCustomRoute, sessionId);
  return {
    connectionId: ref.connectionId, name,
    apiKey, endpoint,
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
