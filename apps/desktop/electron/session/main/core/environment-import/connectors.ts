import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import type { PluginFs, ResolvedAgentHome } from '@gugu/session-core/agents/plugins';
import { AgentHomeSensitiveLinkError, createLocalPluginFs, createMcpAdapter, initializeManagedAgentHome, resolveAgentHomeImportLink } from '@gugu/session-core/agents/plugins/helpers';
import { KeyedMutex } from '@gugu/session-core/lib';

export type CodexConnectorSelection = { localSourceId: string; fingerprint: string };
export type CodexConnectorItem = CodexConnectorSelection & {
  kind: 'connector';
  scope: 'global';
  name: string;
  transport?: 'stdio' | 'http';
  /** Configuration only: import never claims a connection or copies a login session. */
  target: { providerId: 'codex'; path: 'config.toml'; name: string };
  status: 'ready' | 'imported' | 'already-exists' | 'conflict' | 'invalid' | 'source-changed' | 'failed';
  reason?: 'invalid-config' | 'invalid-name' | 'different-config' | 'source-changed' | 'source-missing' | 'source-unreadable' | 'target-changed' | 'target-unreadable' | 'unsafe-target' | 'write-failed';
};
export type CodexConnectorScan = {
  count: number;
  items: CodexConnectorItem[];
  status: 'ok' | 'missing' | 'unreadable' | 'invalid' | 'source-changed' | 'sensitive';
  sourceFingerprint?: string;
};
export type CodexConnectorOptions = { home: ResolvedAgentHome; signal?: AbortSignal };

const disk: typeof fs = process.versions.electron
  ? (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).promises : fs;
const writes = new KeyedMutex();
const CONFIG_LIMIT = 50 * 1024 * 1024; // Same bounded document limit as the existing harness importer.
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) =>
  typeof entry === 'bigint' ? { bigint: entry.toString() }
    : object(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
};

type Source = { scan: CodexConnectorScan; entries: Record<string, unknown>; root: string };
class ConnectorReadError extends Error {
  constructor(readonly status: Exclude<CodexConnectorScan['status'], 'ok'>) { super(`CODEX_CONNECTORS_${status.toUpperCase()}`); }
}

/** Resolve missing suffixes without creating anything. Used to reject aliases of the source home. */
async function canonicalLocation(path: string): Promise<string> {
  try { return await disk.realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalLocation(dirname(path)), relative(dirname(path), path));
  }
}

async function readSource({ home, signal }: CodexConnectorOptions): Promise<Source> {
  signal?.throwIfAborted();
  const root = await disk.realpath(home.userConfigRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConnectorReadError('missing');
    throw new ConnectorReadError('unreadable');
  });
  let input = join(root, 'config.toml');
  let handle;
  try {
    const stat = await disk.lstat(input);
    if (stat.isSymbolicLink()) {
      // The same credential-location/link rules as the full configuration migration (#3270).
      const link = await resolveAgentHomeImportLink(home, input, root);
      if (!link.resolved) throw new ConnectorReadError('unreadable');
      input = link.resolved;
    }
    const expected = await disk.lstat(input);
    handle = await disk.open(input, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (before.ino !== expected.ino || before.dev !== expected.dev) throw new ConnectorReadError('source-changed');
    if (!before.isFile() || before.size > CONFIG_LIMIT) throw new ConnectorReadError('invalid');
    const parts: Buffer[] = [];
    let length = 0;
    for (;;) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(64 * 1024);
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
      if (length > CONFIG_LIMIT) throw new ConnectorReadError('invalid');
      parts.push(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    const current = await disk.lstat(input);
    if (!current.isFile() || before.ino !== current.ino || before.dev !== current.dev || before.size !== length
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.mtimeMs !== current.mtimeMs || before.ctimeMs !== current.ctimeMs) throw new ConnectorReadError('source-changed');
    const bytes = Buffer.concat(parts, length);
    let parsed: Record<string, unknown>;
    try { parsed = parse(bytes.toString('utf8')); }
    catch { throw new ConnectorReadError('invalid'); } // TOML exception text can contain secret-bearing source lines.
    const entries = parsed.mcp_servers ?? {};
    if (!object(entries)) throw new ConnectorReadError('invalid');
    const items = Object.entries(entries).map(([name, raw]): CodexConnectorItem => {
      const transport = object(raw) && typeof raw.url === 'string' ? 'http' : 'stdio';
      const valid = object(raw) && ((transport === 'http' && typeof raw.url === 'string' && raw.url.length > 0)
        || (transport === 'stdio' && typeof raw.command === 'string' && raw.command.trim().length > 0));
      const unsafeName = !name || Object.hasOwn(Object.prototype, name) || name === '__proto__';
      return {
        kind: 'connector', scope: 'global', name, transport,
        localSourceId: `codex:mcp:${digest(stable([root, name]))}`, fingerprint: digest(stable(raw)),
        target: { providerId: 'codex', path: 'config.toml', name },
        status: unsafeName || !valid ? 'invalid' : 'ready',
        ...(unsafeName ? { reason: 'invalid-name' as const } : !valid ? { reason: 'invalid-config' as const } : {}),
      };
    });
    signal?.throwIfAborted();
    return { root, entries, scan: { count: items.length, items, status: 'ok', sourceFingerprint: digest(bytes) } };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ConnectorReadError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConnectorReadError('missing');
    if (error instanceof AgentHomeSensitiveLinkError) throw new ConnectorReadError('sensitive');
    throw new ConnectorReadError('unreadable');
  } finally { await handle?.close(); }
}

/** Validate ownership before either reading or writing the managed config. No source path is writable. */
async function targetFs({ home, signal }: CodexConnectorOptions): Promise<{ fs: PluginFs; path: string }> {
  const shadow = resolve(home.shadowHome), config = resolve(home.configRoot), source = await canonicalLocation(resolve(home.userConfigRoot));
  if (home.providerId !== 'codex' || !inside(shadow, config) || shadow === config) throw new Error('CODEX_CONNECTOR_UNSAFE_TARGET');
  const actual = await canonicalLocation(config);
  if (inside(source, actual) || inside(actual, source)) throw new Error('CODEX_CONNECTOR_UNSAFE_TARGET');
  const path = join(relative(shadow, config), 'config.toml');
  const base = createLocalPluginFs(shadow, { mcpWriteScope: 'owned' });
  const safe = async () => {
    let current = shadow;
    for (const part of ['', ...relative(shadow, join(config, 'config.toml')).split(sep)]) {
      if (part) current = join(current, part);
      const stat = await disk.lstat(current).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error('CODEX_CONNECTOR_UNSAFE_TARGET');
    }
  };
  await safe();
  let lastRead: string | null | undefined;
  return { path, fs: {
    ...base,
    async read(file) {
      signal?.throwIfAborted();
      if (file !== path) throw new Error('CODEX_CONNECTOR_UNSAFE_TARGET');
      await safe();
      lastRead = await base.read(file);
      return lastRead;
    },
    async write(file, content) {
      signal?.throwIfAborted();
      if (file !== path) throw new Error('CODEX_CONNECTOR_UNSAFE_TARGET');
      await safe();
      await initializeManagedAgentHome(home);
      signal?.throwIfAborted();
      const temporary = join(config, `.config.toml.${randomUUID()}.tmp`);
      try {
        await disk.writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
        await safe();
        if (lastRead === undefined || await base.read(file) !== lastRead) throw new Error('CODEX_CONNECTOR_TARGET_CHANGED');
        signal?.throwIfAborted();
        await disk.rename(temporary, join(config, 'config.toml'));
      } finally { await disk.rm(temporary, { force: true }); }
    },
  } };
}

async function readTarget(options: CodexConnectorOptions): Promise<Record<string, unknown>> {
  const target = await targetFs(options);
  const text = await target.fs.read(target.path);
  if (text === null) return {};
  const parsed = parse(text);
  if (parsed.mcp_servers !== undefined && !object(parsed.mcp_servers)) throw new Error('CODEX_CONNECTOR_INVALID_TARGET');
  return (parsed.mcp_servers ?? {}) as Record<string, unknown>;
}
function targetStatus(item: CodexConnectorItem, target: Record<string, unknown>): CodexConnectorItem {
  if (item.status !== 'ready' || !Object.hasOwn(target, item.name)) return item;
  return digest(stable(target[item.name])) === item.fingerprint
    ? { ...item, status: 'already-exists' }
    : { ...item, status: 'conflict', reason: 'different-config' };
}

export async function scanCodexConnectors(options: CodexConnectorOptions): Promise<CodexConnectorScan> {
  let source: Source;
  try { source = await readSource(options); }
  catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof ConnectorReadError) return { count: 0, items: [], status: error.status };
    throw error;
  }
  try {
    const target = await readTarget(options);
    options.signal?.throwIfAborted();
    return { ...source.scan, items: source.scan.items.map((item) => targetStatus(item, target)) };
  } catch (error) {
    options.signal?.throwIfAborted();
    const reason = (error as Error).message === 'CODEX_CONNECTOR_UNSAFE_TARGET' ? 'unsafe-target' : 'target-unreadable';
    return { ...source.scan, items: source.scan.items.map((item) => item.status === 'ready' ? { ...item, status: 'failed', reason } : item) };
  }
}

export async function importCodexConnectors(options: CodexConnectorOptions & { selection: readonly CodexConnectorSelection[] }): Promise<{ items: CodexConnectorItem[] }> {
  const release = await writes.acquire(resolve(options.home.configRoot), options.signal);
  try {
    options.signal?.throwIfAborted();
    let source: Source;
    try { source = await readSource(options); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof ConnectorReadError)) throw error;
      const reason = error.status === 'missing' ? 'source-missing' : error.status === 'source-changed' ? 'source-changed' : 'source-unreadable';
      return { items: options.selection.map((selection): CodexConnectorItem => ({
        ...selection, kind: 'connector', scope: 'global', name: '', target: { providerId: 'codex', path: 'config.toml', name: '' },
        status: error.status === 'missing' || error.status === 'source-changed' ? 'source-changed' : 'failed', reason,
      })) };
    }
    const byId = new Map(source.scan.items.map((item) => [item.localSourceId, item]));
    const items: CodexConnectorItem[] = [];
    for (const selection of new Map(options.selection.map((entry) => [entry.localSourceId, entry])).values()) {
      options.signal?.throwIfAborted();
      const item = byId.get(selection.localSourceId);
      if (!item || item.fingerprint !== selection.fingerprint) {
        items.push({ kind: 'connector', scope: 'global', name: item?.name ?? '', ...selection,
          target: { providerId: 'codex', path: 'config.toml', name: item?.name ?? '' }, status: 'source-changed', reason: item ? 'source-changed' : 'source-missing' });
        continue;
      }
      if (item.status !== 'ready') { items.push(item); continue; }
      try {
        const current = targetStatus(item, await readTarget(options));
        if (current.status !== 'ready') { items.push(current); continue; }
        const target = await targetFs(options);
        // Reuse the native adapter's owned-only writes and whole-document merge/conflict protection.
        // Keep the entire native entry, including env_vars, timeouts, auth and future legal fields.
        const adapter = createMcpAdapter({ configPath: target.path, format: 'toml', serversKey: 'mcp_servers',
          toNative: (entry) => entry.codexNative as Record<string, unknown>,
          fromNative: (name, codexNative) => ({ name, codexNative }),
        });
        await adapter.writeServers(target.fs, [{ name: item.name, codexNative: source.entries[item.name] }]);
        if (targetStatus(item, await readTarget(options)).status !== 'already-exists') throw new Error('CODEX_CONNECTOR_READBACK_FAILED');
        items.push({ ...item, status: 'imported' });
      } catch (error) {
        options.signal?.throwIfAborted();
        // Adapter/parser error strings can include source data. Only enumerated metadata crosses this boundary.
        const message = (error as Error).message;
        const reason = message === 'CODEX_CONNECTOR_UNSAFE_TARGET' ? 'unsafe-target' : message === 'CODEX_CONNECTOR_TARGET_CHANGED' ? 'target-changed' : 'write-failed';
        items.push({ ...item, status: reason === 'target-changed' ? 'conflict' : 'failed', reason });
      }
    }
    return { items };
  } finally { release(); }
}
