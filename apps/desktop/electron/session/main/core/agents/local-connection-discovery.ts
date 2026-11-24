import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import { normalizeModelBaseUrl, type CustomModelMeta, type DiscoverySource, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import { providerPresets } from '@gugu/session-core/models/provider-presets';

/**
 * Read-only scan of the AI connections this machine already has: the official OpenAI key Codex keeps, the key in the
 * login shell, and every provider declared in Codex's config.toml. It never runs a program, never touches the network and
 * never writes. Secrets stay behind `discoveredSecret`; everything else on a result is safe to log and to show.
 * (A ChatGPT sign-in is not handled here: the native Codex subscription already lists itself.)
 */
export type DiscoveryIssue = {
  code: 'key-missing' | 'invalid-config' | 'unreadable' | 'unsupported-store' | 'incompatible';
  where: 'auth.json' | 'config.toml';
  provider?: string;
};

export type DiscoveredConnection = {
  /** Same address and key → same id, on every scan and every run; a different key is a different connection. */
  id: string;
  /** SHA-256 over address and the SHA-256 of the key: enough to recognise a connection, useless as a key. */
  identity: string;
  source: DiscoverySource;
  name: string;
  preset: string | null;
  endpoints: CustomModelMeta['endpoints'];
  models: CustomModelMeta['models'];
  keyLast4: string;
  /** Codex provider ids that resolved to this connection. */
  aliases: string[];
};

export type LocalDiscovery = { connections: DiscoveredConnection[]; issues: DiscoveryIssue[] };

/**
 * What the log says about unreadable sources: codes and provider ids only, never a value. `:` joins the parts because
 * the log redactor takes anything shaped like `a@b.c` for an email and would blank the signature.
 */
export function describeDiscoveryIssues(issues: DiscoveryIssue[]): string {
  return issues.map(({ code, where, provider }) => `${code}:${where}${provider ? `:${provider}` : ''}`).join(' ');
}

const secrets = new WeakMap<DiscoveredConnection, string>();
/** The key of a discovered connection. For the host process that is about to store it or call the provider only. */
export function discoveredSecret(connection: DiscoveredConnection): string | undefined {
  return secrets.get(connection);
}

const OFFICIAL = providerPresets.find(({ id }) => id === 'openai')!;
const OFFICIAL_BASE = OFFICIAL.endpoints[0]!.baseUrl;
const MAX_FILE = 1_000_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** What makes two connections the same one: where they go and which key they use. Not reversible to the key. */
export const discoveryIdentity = (baseUrl: string, key: string) => sha256(`${baseUrl}\0${sha256(key)}`);
/** The only part of a key anything off this machine may see; nothing for a key too short to hide half of itself. */
export const keyLast4 = (key: string) => key.length >= 12 ? key.slice(-4) : '';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** A stable RFC 4122 id for this identity, so a connection keeps its id until its address or key changes. */
function connectionId(identity: string): string {
  const bytes = createHash('sha256').update('gugu-discovered-connection\0').update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type FileRead = { ok: true; text: string } | { ok: false; reason: 'missing' | 'unreadable' };
async function readSmall(path: string): Promise<FileRead> {
  try {
    const content = await readFile(path, 'utf8');
    return content.length > MAX_FILE ? { ok: false, reason: 'unreadable' } : { ok: true, text: content };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
}

/** The address exactly as written, when the generic connection can hold it without rewriting it. */
function holdableAddress(raw: string): string | null {
  try {
    const written = new URL(raw.trim()).toString().replace(/\/+$/, '');
    return normalizeModelBaseUrl(raw) === written ? written : null;
  } catch { return null; }
}

function endpointsFor(baseUrl: string, protocols: ModelProtocol[]): CustomModelMeta['endpoints'] {
  return protocols.map(protocol => ({ protocol, baseUrl }));
}

function hostName(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

export async function discoverLocalConnections(input: { root: string; env: Record<string, string | undefined> }): Promise<LocalDiscovery> {
  const issues: DiscoveryIssue[] = [];
  const found = new Map<string, DiscoveredConnection>();

  function add(candidate: Omit<DiscoveredConnection, 'id' | 'identity' | 'keyLast4'> & { baseUrl: string; key: string }) {
    const { baseUrl, key, ...rest } = candidate;
    const identity = discoveryIdentity(baseUrl, key);
    const existing = found.get(identity);
    if (existing) {
      for (const endpoint of rest.endpoints) if (!existing.endpoints.some(({ protocol }) => protocol === endpoint.protocol)) existing.endpoints.push(endpoint);
      for (const model of rest.models) if (!existing.models.some(({ id }) => id === model.id)) existing.models.push(model);
      for (const alias of rest.aliases) if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
      return;
    }
    const connection: DiscoveredConnection = { ...rest, id: connectionId(identity), identity, keyLast4: keyLast4(key) };
    secrets.set(connection, key);
    found.set(identity, connection);
  }

  // config.toml first: it names the sign-in storage, the official address override and every provider.
  let config: Record<string, unknown> = {};
  const configFile = await readSmall(join(input.root, 'config.toml'));
  if (!configFile.ok && configFile.reason === 'unreadable') issues.push({ code: 'unreadable', where: 'config.toml' });
  if (configFile.ok) {
    try { config = parseTOML(configFile.text); } catch { issues.push({ code: 'invalid-config', where: 'config.toml' }); }
  }

  // Where a key aimed at "OpenAI" really goes: the user's own override if there is one. Reported once, not per key.
  let officialAddress: string | null | undefined;
  const official = (key: string, source: DiscoverySource) => {
    if (officialAddress === undefined) {
      const written = text(config.openai_base_url) ?? text(input.env.OPENAI_BASE_URL);
      officialAddress = written === undefined ? OFFICIAL_BASE : holdableAddress(written);
      if (!officialAddress) issues.push({ code: 'incompatible', where: 'config.toml', provider: 'openai' });
    }
    const address = officialAddress;
    if (!address) return;
    if (address === OFFICIAL_BASE) {
      add({ source, name: OFFICIAL.name, preset: OFFICIAL.id, baseUrl: address, key, models: [], aliases: [],
        endpoints: OFFICIAL.endpoints.map(({ protocol, baseUrl }) => ({ protocol, baseUrl })) });
    } else {
      add({ source, name: `${OFFICIAL.name} (${hostName(address)})`, preset: null, baseUrl: address, key, models: [], aliases: [],
        endpoints: endpointsFor(address, ['openai-responses']) });
    }
  };

  // 1. The official key Codex keeps, following the same mode rule Codex itself applies.
  const authFile = await readSmall(join(input.root, 'auth.json'));
  if (!authFile.ok && authFile.reason === 'unreadable') issues.push({ code: 'unreadable', where: 'auth.json' });
  if (authFile.ok) {
    let auth: unknown;
    try { auth = JSON.parse(authFile.text); } catch { auth = undefined; }
    const store = config.cli_auth_credentials_store;
    if (!isRecord(auth)) issues.push({ code: 'invalid-config', where: 'auth.json' });
    else if (store !== undefined && store !== 'file') issues.push({ code: 'unsupported-store', where: 'auth.json' });
    else {
      const key = text(auth.OPENAI_API_KEY);
      const active = auth.auth_mode === undefined ? key !== undefined && auth.tokens == null : auth.auth_mode === 'apikey';
      if (key && active) official(key, 'codex-auth');
    }
  }

  // 2. The key in the login shell, aimed at the official address unless the user's own settings say otherwise.
  const shellKey = text(input.env.OPENAI_API_KEY);
  if (shellKey) official(shellKey, 'shell-env');

  // 3. Every provider Codex was explicitly told about.
  const providers = isRecord(config.model_providers) ? config.model_providers : {};
  const profiles = isRecord(config.profiles) ? Object.values(config.profiles).filter(isRecord) : [];
  const defaultProvider = text(config.model_provider) ?? 'openai';
  const modelsFor = (provider: string) => {
    const ids = [{ provider: defaultProvider, model: text(config.model) }, ...profiles.map(profile => ({ provider: text(profile.model_provider) ?? defaultProvider, model: text(profile.model) }))]
      .filter(entry => entry.provider === provider && entry.model).map(entry => entry.model!);
    return [...new Set(ids)].map(id => ({ id }));
  };
  for (const [id, raw] of Object.entries(providers)) {
    if (!isRecord(raw) || id === 'openai' || raw.requires_openai_auth === true) continue;
    const baseUrl = text(raw.base_url);
    if (!baseUrl) continue;
    const wire = raw.wire_api === undefined ? 'responses' : raw.wire_api;
    const address = holdableAddress(baseUrl);
    const customised = [raw.query_params, raw.http_headers, raw.env_http_headers].some(value => isRecord(value) && Object.keys(value).length > 0);
    if (!address || customised || (wire !== 'responses' && wire !== 'chat')) { issues.push({ code: 'incompatible', where: 'config.toml', provider: id }); continue; }
    const envKey = text(raw.env_key);
    const key = (envKey ? text(input.env[envKey]) : undefined) ?? text(raw.experimental_bearer_token);
    if (!key) { if (envKey) issues.push({ code: 'key-missing', where: 'config.toml', provider: id }); continue; }
    add({
      source: 'codex-provider', name: text(raw.name) ?? id, preset: address === OFFICIAL_BASE ? OFFICIAL.id : null, baseUrl: address, key, aliases: [id], models: modelsFor(id),
      endpoints: endpointsFor(address, [wire === 'chat' ? 'openai-chat-completions' : 'openai-responses']),
    });
  }

  // Two different keys can carry the same name (an official key in the file and another in the shell); the list shows names only.
  const connections = [...found.values()];
  const shared = new Set(connections.map(({ name }) => name).filter((name, index, names) => names.indexOf(name) !== index));
  for (const connection of connections) if (shared.has(connection.name) && connection.keyLast4) connection.name = `${connection.name} (…${connection.keyLast4})`;
  return { connections, issues };
}
