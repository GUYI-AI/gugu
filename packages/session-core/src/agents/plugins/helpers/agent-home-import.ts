import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as toml from 'smol-toml';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import type { ResolvedAgentHome } from '../capabilities/config-root';
import type { AgentHomeGroupId, AgentHomeImportPath } from '../capabilities/session-bundle';
import type { PluginFs } from '../../runtime/fs';
import { filterUserHooks } from './hooks';

const disk: typeof fs = process.versions.electron
  ? (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).promises : fs;
export const AGENT_HOME_MARKER = '.gugu-agent-home.json';
const FILE_LIMIT = 50 * 1024 * 1024;
const ROOT_LIMIT = 2 * 1024 * 1024 * 1024;
const SENSITIVE_NAME = /^(?:auth\.json|\.?credentials(?:\..*)?|\.env(?:\..*)?|\.audit-key|.*(?:token|cookie|keychain).*)$/i;
const DATABASE_NAME = /(?:\.sqlite(?:-\w+)?|\.db|-(?:wal|shm))$/i;

export class AgentHomeNotImported extends Error {
  readonly code = 'AGENT_HOME_NOT_IMPORTED';
  constructor(readonly providerId: string, options?: ErrorOptions) {
    super(`In Settings → Subscriptions, import local configuration or sign in to ${providerId}. On a server, run gugu-server agent-home import ${providerId} to import, or use its sign-in flow if you chose Skip.`, options);
    this.name = 'AgentHomeNotImported';
  }
}
export type AgentHomeImportIssue = {
  path: string;
  reason: 'symlink' | 'sensitive' | 'database' | 'tooLarge' | 'sourceChanged' | 'unreadable';
};
export type AgentHomeMarker = {
  importedAt: string;
  sourceRoot: string;
  groups: AgentHomeGroupId[];
  files: Record<string, string>;
  migratedFrom?: 'shared';
  skipped?: true;
  terminalNeedsSignIn?: boolean;
  oldSessionsSkipped?: number;
  upgradeSignIn?: 'copied' | 'relogin';
  legacyBaseline?: boolean;
};
type PathSpec = Exclude<AgentHomeImportPath, string>;
type Item = {
  id: string; path: string; target: string; group: AgentHomeGroupId; spec: PathSpec;
  hash: string; mode: number; count: number; mcpCount: number;
};
type SnapshotItem = Item & { bytes: Buffer };
export type AgentHomeDiffState = 'unchanged' | 'userChanged' | 'guguChanged' | 'bothChanged' | 'userAdded' | 'userDeleted';
export type AgentHomeDiffEntry = { id: string; path: string; group: AgentHomeGroupId; state: AgentHomeDiffState; uncertain?: boolean; revision: string };

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function normalize(spec: AgentHomeImportPath): PathSpec { return typeof spec === 'string' ? { path: spec } : spec; }
function localPath(path: string, sibling = false): string {
  const allowedSibling = sibling && /^\.\.\/[^/\\]+$/.test(path);
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\')
    || (path.split('/').includes('..') && !allowedSibling)) {
    throw new Error('Import declaration contains an unsafe relative path');
  }
  return path.replace(/\/$/, '');
}
function excluded(path: string, entries: readonly string[]): boolean {
  return entries.some((entry) => path === entry.replace(/\/$/, '') || path.startsWith(`${entry.replace(/\/$/, '')}/`));
}
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === 'bigint') return { bigint: entry.toString() };
    return object(entry) ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry;
  });
}
function hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function parseDocument(bytes: Buffer, path: string): Record<string, unknown> {
  if (path.endsWith('.toml')) return toml.parse(bytes.toString('utf8'));
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(bytes.toString('utf8'), errors, { allowTrailingComma: true });
  if (errors.length || !object(parsed)) throw new Error('Configuration is not a readable object');
  return parsed;
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!object(value) || value instanceof Date) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}
function project(bytes: Buffer, spec: PathSpec, group?: AgentHomeGroupId): Buffer {
  if (!spec.keys && !spec.omitKeys && group !== 'hooks') return bytes;
  const parsed = parseDocument(bytes, spec.path);
  if (group === 'hooks' && object(parsed.hooks)) {
    parsed.hooks = Object.fromEntries(Object.entries(parsed.hooks).map(([event, entries]) =>
      [event, Array.isArray(entries) ? filterUserHooks(entries) : entries]));
  }
  const subset = Object.fromEntries(Object.entries(parsed).filter(([key]) =>
    (!spec.keys || spec.keys.includes(key)) && !spec.omitKeys?.includes(key)));
  return Buffer.from(spec.path.endsWith('.toml') ? toml.stringify(sorted(subset) as Record<string, unknown>) : stable(subset));
}
function itemId(path: string, spec: PathSpec): string {
  return spec.keys || spec.omitKeys ? `${path}#${stable({ keys: spec.keys, omitKeys: spec.omitKeys })}` : path;
}

/** Check each segment below the chosen boundary, including the source root itself. */
async function noLinks(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Import path escapes its root');
  let current = root;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    if ((await disk.lstat(current)).isSymbolicLink()) throw Object.assign(new Error('Symlink is not imported'), { code: 'ELOOP' });
  }
}

/** Create below the private shadow home without traversing existing directory links. */
async function makeDirectory(home: ResolvedAgentHome, path: string): Promise<void> {
  const rel = relative(home.shadowHome, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Import path escapes its root');
  await disk.mkdir(dirname(home.shadowHome), { recursive: true, mode: 0o700 });
  let current = home.shadowHome;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try { await disk.mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await noLinks(home.shadowHome, current);
    await disk.chmod(current, 0o700);
  }
}

/** One handle and bounded reads; never reopen the source by path to copy it. */
async function snapshot(root: string, path: string, limit = FILE_LIMIT): Promise<Buffer | null> {
  try {
    await noLinks(root, path);
    const before = await disk.lstat(path);
    if (!before.isFile()) return null;
    if (before.size > limit) throw Object.assign(new Error('Import file exceeds size limit'), { code: 'EFBIG' });
    const handle = await disk.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw Object.assign(new Error('Source changed'), { code: 'ESTALE' });
      const bytes = Buffer.alloc(before.size + 1);
      let read = 0;
      while (read < bytes.length) {
        const result = await handle.read(bytes, read, bytes.length - read, null);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      const after = await handle.stat();
      await noLinks(root, path);
      const current = await disk.lstat(path);
      if (read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs) {
        throw Object.assign(new Error('Source changed'), { code: 'ESTALE' });
      }
      return bytes.subarray(0, read);
    } finally { await handle.close(); }
  } catch (error) { if (missing(error)) return null; throw error; }
}
function issue(path: string, error: unknown): AgentHomeImportIssue {
  const code = (error as NodeJS.ErrnoException).code;
  return { path, reason: code === 'ELOOP' ? 'symlink' : code === 'EFBIG' ? 'tooLarge' : code === 'ESTALE' ? 'sourceChanged' : 'unreadable' };
}

async function collect(home: ResolvedAgentHome, consume?: (items: SnapshotItem[]) => Promise<void>) {
  const items: Item[] = [], issues: AgentHomeImportIssue[] = [];
  const mcpSecrets = new Set<string>();
  const mcpNames = new Set<string>();
  let projectMcpCount = 0;
  let bytesRead = 0, newestMtime = 0;
  const declarations = home.importGroups.flatMap((group) => group.paths.map((path) => ({ group: group.id, spec: normalize(path) })));
  const seen = new Set<string>();
  const visit = async (path: string, boundary: string, depth: number): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    if (depth > 32) { issues.push({ path, reason: 'unreadable' }); return; }
    const full = resolve(home.userConfigRoot, path);
    if (excluded(path, home.credentialPaths) || SENSITIVE_NAME.test(basename(path))) {
      issues.push({ path, reason: 'sensitive' }); return;
    }
    if (excluded(path, home.carryExclusions)) return;
    if (DATABASE_NAME.test(path)) { issues.push({ path, reason: 'database' }); return; }
    const snapshots: SnapshotItem[] = [];
    try {
      await noLinks(boundary, full);
      const stat = await disk.lstat(full);
      newestMtime = Math.max(newestMtime, stat.mtimeMs);
      if (stat.isDirectory()) {
        for (const name of (await disk.readdir(full)).sort()) await visit(path ? `${path}/${name}` : name, boundary, depth + 1);
        return;
      }
      if (!stat.isFile()) return;
      if (stat.size > FILE_LIMIT || bytesRead + stat.size > ROOT_LIMIT) { issues.push({ path, reason: 'tooLarge' }); return; }
      const content = await snapshot(boundary, full);
      if (!content) return;
      bytesRead += content.length;
      if (/\.(?:json|toml)$/.test(path)) {
        try {
          const doc = parseDocument(content, path);
          const servers = doc.mcpServers ?? doc.mcp_servers;
          if (object(servers)) for (const [name, server] of Object.entries(servers)) {
            mcpNames.add(name);
            if (object(server) && (object(server.env) || object(server.headers)
              || Array.isArray(server.args) && server.args.some((arg: unknown) => typeof arg === 'string' && /(?:--(?:api[-_]?key|token|secret|password)|(?:sk|key)-[a-z0-9]{12})/i.test(arg)))) mcpSecrets.add(name);
          }
          if (object(doc.projects)) for (const project of Object.values(doc.projects)) {
            if (object(project) && object(project.mcpServers)) projectMcpCount += Object.keys(project.mcpServers).length;
          }
        } catch { /* Only declared field projections require a parseable document. */ }
      }
      const matches = declarations.filter(({ spec }) => path === localPath(spec.path, true) || path.startsWith(`${localPath(spec.path, true)}/`));
      const selected = matches.length ? matches : [{ group: 'settings' as const, spec: { path } }];
      for (const { group, spec } of selected) {
        const target = localPath(spec.target ?? path);
        const projected = project(content, spec, group);
        let count = !spec.keys && !spec.omitKeys || projected.toString('utf8') !== '{}' ? 1 : 0;
        let mcpCount = 0;
        if (/\.(?:json|toml)$/.test(path)) {
          try {
            const doc = parseDocument(projected, path), servers = doc.mcpServers ?? doc.mcp_servers;
            mcpCount = object(servers) ? Object.keys(servers).length : 0;
            if (group === 'mcp') count = mcpCount;
            if (group === 'hooks') count = object(doc.hooks) ? Object.values(doc.hooks).reduce<number>((total, hooks) => total + (Array.isArray(hooks)
              ? hooks.reduce<number>((sum, entry: unknown) => sum + (object(entry) && Array.isArray(entry.hooks) ? entry.hooks.length : 1), 0) : 0), 0) : 0;
          } catch { /* Unprojected files may be arbitrary user content. */ }
        }
        const item: Item = { id: itemId(path, spec), path, target, group, spec, hash: hash(projected), mode: stat.mode & 0o777, count, mcpCount };
        items.push(item);
        snapshots.push({ ...item, bytes: projected });
      }
    } catch (error) { if (!missing(error)) issues.push(issue(path, error)); }
    // Source failures are listed; destination writes and stale choices must fail the operation.
    // Keep at most one source file in memory even when the root approaches its 2 GiB limit.
    if (snapshots.length) await consume?.(snapshots);
  };
  await visit('', home.userConfigRoot, 0);
  for (const { spec } of declarations) {
    if (spec.path.startsWith('../')) await visit(localPath(spec.path, true), dirname(home.userConfigRoot), 0);
  }
  return { items, issues, newestMtime, mcpSecrets: [...mcpSecrets], mcpNames: [...mcpNames], projectMcpCount, bytesRead };
}

export async function readAgentHomeMarker(home: ResolvedAgentHome): Promise<AgentHomeMarker | null> {
  try {
    const bytes = await snapshot(home.shadowHome, join(home.shadowHome, AGENT_HOME_MARKER));
    if (!bytes) return null;
    await makeDirectory(home, home.configRoot);
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (object(value) && value.seed === 'copied' && !value.importedAt) {
      const legacy: AgentHomeMarker = {
        importedAt: new Date((await disk.stat(join(home.shadowHome, AGENT_HOME_MARKER))).mtimeMs).toISOString(),
        sourceRoot: home.userConfigRoot, groups: home.importGroups.map((group) => group.id),
        files: {}, legacyBaseline: true,
      };
      await writeMarker(home, legacy);
      return legacy;
    }
    if (!object(value) || typeof value.importedAt !== 'string' || !object(value.files) || !Array.isArray(value.groups)) {
      throw new Error('Managed configuration import record is invalid');
    }
    return value as AgentHomeMarker;
  } catch (error) { if (missing(error)) return null; throw error; }
}
async function writeMarker(home: ResolvedAgentHome, marker: AgentHomeMarker): Promise<void> {
  const destination = join(home.shadowHome, AGENT_HOME_MARKER), temporary = `${destination}.${randomUUID()}`;
  await disk.writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { await disk.rename(temporary, destination); }
  finally { await disk.rm(temporary, { force: true }); }
}
async function writeItem(home: ResolvedAgentHome, items: SnapshotItem[], overwrite: boolean, guard?: (current: Buffer | null) => void): Promise<void> {
  const target = join(home.configRoot, items[0]!.target);
  await makeDirectory(home, dirname(target));
  const projected = items.some((item) => item.spec.keys || item.spec.omitKeys);
  const existing = overwrite || projected ? await snapshot(home.configRoot, target) : null;
  guard?.(existing);
  let bytes = items[0]!.bytes;
  if (projected) {
    let current: Record<string, unknown> = {};
    if (existing && !overwrite) return;
    if (existing) current = parseDocument(existing, target);
    for (const item of items) {
      const subset = parseDocument(item.bytes, item.spec.path);
      if (item.spec.keys) for (const key of item.spec.keys) delete current[key];
      else for (const key of Object.keys(current)) if (!item.spec.omitKeys?.includes(key)) delete current[key];
      if (object(subset)) Object.assign(current, subset);
    }
    bytes = Buffer.from(target.endsWith('.toml') ? toml.stringify(current) : `${JSON.stringify(current, null, 2)}\n`);
  }
  if (!overwrite) {
    await disk.writeFile(target, bytes, { mode: items[0]!.mode, flag: 'wx' }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    return;
  }
  await noLinks(home.configRoot, target).catch((error: unknown) => { if (!missing(error)) throw error; });
  const temporary = `${target}.${randomUUID()}`;
  await disk.writeFile(temporary, bytes, { mode: items[0]!.mode, flag: 'wx' });
  try { await disk.rename(temporary, target); }
  finally { await disk.rm(temporary, { force: true }); }
}
function byTarget(items: SnapshotItem[]): SnapshotItem[][] {
  const grouped = new Map<string, SnapshotItem[]>();
  for (const item of items) grouped.set(item.target, [...(grouped.get(item.target) ?? []), item]);
  return [...grouped.values()];
}
function groupCount(items: Item[], group: AgentHomeGroupId): number {
  if (group === 'skills' || group === 'agents') {
    return new Set(items.map((item) => {
      const prefix = item.spec.path.replace(/\/$/, '');
      return item.path.startsWith(`${prefix}/`) ? `${prefix}/${item.path.slice(prefix.length + 1).split('/')[0]}` : item.path;
    })).size;
  }
  return items.reduce((count, item) => count + item.count, 0);
}

/** Metadata only: source file contents stay in this process. */
export async function scanAgentHome(home: ResolvedAgentHome) {
  const { items, issues, newestMtime, mcpSecrets, mcpNames, projectMcpCount } = await collect(home);
  const marker = await readAgentHomeMarker(home);
  return {
    providerId: home.providerId, userRoot: home.userConfigRoot, marker, newestMtime,
    groups: home.importGroups.map((group) => {
      const members = items.filter((item) => item.group === group.id);
      return { id: group.id, count: groupCount(members, group.id), mcpCount: members.reduce((count, item) => count + item.mcpCount, 0) };
    }),
    issues,
    mcpSecrets, mcpNames, projectMcpCount,
  };
}
export async function importAgentHome(home: ResolvedAgentHome, options: {
  groups: ReadonlySet<AgentHomeGroupId>; now?: Date; migratedFrom?: 'shared';
  historyPaths?: readonly string[];
  skip?: boolean;
  beforeCommit?: (issues: readonly AgentHomeImportIssue[]) => Promise<Pick<AgentHomeMarker, 'upgradeSignIn' | 'terminalNeedsSignIn' | 'oldSessionsSkipped'> | void>;
}): Promise<{ marker: AgentHomeMarker; issues: AgentHomeImportIssue[] }> {
  const existing = await readAgentHomeMarker(home);
  if (existing && (!existing.skipped || !options.groups.size)) return { marker: existing, issues: [] };
  await makeDirectory(home, home.configRoot);
  let copied = 0;
  const { items, issues } = options.groups.size ? await collect(home, async (snapshots) => {
    for (const entries of byTarget(snapshots.filter((item) => options.groups.has(item.group)))) {
      await writeItem(home, entries, existing?.skipped === true);
      copied += (await disk.stat(join(home.configRoot, entries[0]!.target))).size;
    }
  }) : { items: [] as Item[], issues: [] as AgentHomeImportIssue[] };
  const selected = items.filter((item) => options.groups.has(item.group));
  if (options.historyPaths?.length) issues.push(...await copyAgentHomeHistory(home, options.historyPaths, copied));
  const upgrade = await options.beforeCommit?.(issues);
  const marker: AgentHomeMarker = {
    importedAt: (options.now ?? new Date()).toISOString(), sourceRoot: home.userConfigRoot,
    groups: [...options.groups], files: Object.fromEntries(selected.map((item) => [item.id, item.hash])),
    ...(options.skip ? { skipped: true as const } : {}),
    ...(options.migratedFrom ? { migratedFrom: options.migratedFrom } : {}),
    ...(upgrade ?? {}),
  };
  await writeMarker(home, marker);
  return { marker, issues };
}

/** Existing Gugu transcripts may exceed 50 MiB; stream them under the same 2 GiB root budget. */
export async function copyAgentHomeHistory(home: ResolvedAgentHome, paths: readonly string[], copied = 0): Promise<AgentHomeImportIssue[]> {
  const issues: AgentHomeImportIssue[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > 32) { issues.push({ path, reason: 'unreadable' }); return; }
    if (SENSITIVE_NAME.test(basename(path)) || excluded(path, home.credentialPaths) || DATABASE_NAME.test(path)) return;
    const source = join(home.userConfigRoot, localPath(path)), target = join(home.configRoot, localPath(path));
    let created = false;
    try {
      await noLinks(home.userConfigRoot, source);
      const before = await disk.lstat(source);
      if (before.isDirectory()) {
        for (const name of (await disk.readdir(source)).sort()) await visit(`${path}/${name}`, depth + 1);
        return;
      }
      if (!before.isFile()) return;
      if (copied + before.size > ROOT_LIMIT) { issues.push({ path, reason: 'tooLarge' }); return; }
      const input = await disk.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await input.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev) throw Object.assign(new Error('Source changed'), { code: 'ESTALE' });
        await makeDirectory(home, dirname(target));
        let output;
        try { output = await disk.open(target, 'wx', before.mode & 0o777); created = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
        let read = 0;
        try {
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            const result = await input.read(buffer, 0, buffer.length, null);
            if (!result.bytesRead) break;
            if (copied + read + result.bytesRead > ROOT_LIMIT) throw Object.assign(new Error('Import root exceeds limit'), { code: 'EFBIG' });
            let written = 0;
            while (written < result.bytesRead) {
              written += (await output.write(buffer, written, result.bytesRead - written, null)).bytesWritten;
            }
            read += result.bytesRead;
          }
        } finally { await output.close(); }
        const after = await input.stat();
        await noLinks(home.userConfigRoot, source);
        const current = await disk.lstat(source);
        if (read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) throw Object.assign(new Error('Source changed'), { code: 'ESTALE' });
        copied += read;
      } finally { await input.close(); }
    } catch (error) {
      if (created) await disk.rm(target, { force: true });
      if (!missing(error)) issues.push(issue(path, error));
    }
  };
  for (const path of paths) await visit(localPath(path), 0);
  return issues;
}
export async function diffAgentHome(home: ResolvedAgentHome): Promise<{ entries: AgentHomeDiffEntry[]; issues: AgentHomeImportIssue[] }> {
  const marker = await readAgentHomeMarker(home);
  if (!marker) throw new AgentHomeNotImported(home.providerId);
  const { items, issues } = await collect(home), source = new Map(items.map((item) => [item.id, item]));
  const entries: AgentHomeDiffEntry[] = [];
  for (const id of new Set([...Object.keys(marker.files), ...source.keys()])) {
    const item = source.get(id), path = item?.path ?? id.split('#')[0]!;
    const declaration = home.importGroups.flatMap((group) => group.paths.map((pathSpec) => ({ group: group.id, spec: normalize(pathSpec) })))
      .find(({ spec }) => itemId(path, spec) === id && (spec.path === path || path.startsWith(`${spec.path.replace(/\/$/, '')}/`)));
    const group = item?.group ?? declaration?.group ?? 'settings', spec = item?.spec ?? declaration?.spec ?? { path };
    const target = localPath(item?.target ?? spec.target ?? path);
    let managedHash: string | undefined;
    try {
      const current = await snapshot(home.configRoot, join(home.configRoot, target));
      if (current) managedHash = hash(project(current, spec, group));
    } catch (error) { issues.push(issue(path, error)); continue; }
    const base = marker.files[id];
    // A rejected source is unreadable, never proof of a deletion.
    if (!item && issues.some((entry) => path === entry.path || path.startsWith(`${entry.path}/`))) continue;
    const uncertain = !base && marker.legacyBaseline === true;
    const state: AgentHomeDiffState = !item ? 'userDeleted' : uncertain ? (managedHash === item.hash ? 'unchanged' : 'bothChanged') : !base ? 'userAdded'
      : item.hash === base ? (managedHash === base ? 'unchanged' : 'guguChanged')
      : managedHash === base ? 'userChanged' : managedHash === item.hash ? 'unchanged' : 'bothChanged';
    entries.push({ id, path, group, state, ...(uncertain ? { uncertain: true } : {}),
      revision: hash(stable({ base, user: item?.hash, managed: managedHash })) });
  }
  return { entries, issues };
}
export async function reimportAgentHome(home: ResolvedAgentHome, decisions: ReadonlySet<string>, expected?: ReadonlyMap<string, string>) {
  const marker = await readAgentHomeMarker(home);
  if (!marker) throw new AgentHomeNotImported(home.providerId);
  const diff = await diffAgentHome(home);
  if (expected && diff.entries.some((entry) => decisions.has(entry.id) && expected.get(entry.id) !== entry.revision)) {
    throw new Error('Configuration changed; review the differences again before importing');
  }
  const allowed = new Set(diff.entries.filter((entry) => decisions.has(entry.id)
    && ['userChanged', 'userAdded', 'bothChanged'].includes(entry.state)).map((entry) => entry.id));
  const revisions = expected ?? new Map(diff.entries.map((entry) => [entry.id, entry.revision]));
  const { items, issues } = await collect(home, async (snapshots) => {
    for (const entries of byTarget(snapshots.filter((item) => allowed.has(item.id)))) {
      await writeItem(home, entries, true, (current) => {
        for (const item of entries) {
          const managed = current ? hash(project(current, item.spec, item.group)) : undefined;
          if (revisions.get(item.id) !== hash(stable({ base: marker.files[item.id], user: item.hash, managed }))) {
            throw new Error('Configuration changed; review the differences again before importing');
          }
        }
      });
    }
  }), selected = items.filter((item) => allowed.has(item.id));
  for (const item of selected) marker.files[item.id] = item.hash;
  marker.groups = [...new Set([...marker.groups, ...selected.map((item) => item.group)])];
  await writeMarker(home, marker);
  return { issues: [...diff.issues, ...issues], imported: selected.length };
}

/** Migration-only edit, guarded by the same safe read and an optimistic content check. */
export async function updateAgentHomeSource(
  home: ResolvedAgentHome, path: string,
  update: (fs: Pick<PluginFs, 'read' | 'write'>, path: string) => Promise<void>
): Promise<AgentHomeImportIssue | undefined> {
  const target = join(home.userConfigRoot, localPath(path));
  let before: Buffer | null;
  try { before = await snapshot(home.userConfigRoot, target); }
  catch (error) { return issue(path, error); }
  if (!before) return;
  const original = before.toString('utf8');
  let next = original;
  try {
    await update({ read: async () => original, write: async (_path, content) => { next = content; } }, path);
  } catch (error) { return issue(path, error); }
  if (next === original) return;
  const temporary = `${target}.gugu-${randomUUID()}`;
  await disk.writeFile(temporary, next, { mode: (await disk.lstat(target)).mode & 0o777, flag: 'wx' });
  try {
    const current = await snapshot(home.userConfigRoot, target);
    if (!current || hash(current) !== hash(before)) throw new Error('Source changed; retry migration');
    await disk.rename(temporary, target);
  } finally { await disk.rm(temporary, { force: true }); }
}
