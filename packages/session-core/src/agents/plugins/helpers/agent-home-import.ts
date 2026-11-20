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
import {
  AgentHomeSensitiveLinkError,
  checkAgentHomeImportSpace,
  importedLinkTarget,
  resolveAgentHomeImportLink,
  streamImportFile
} from './agent-home-migration';
export * from './agent-home-migration';
export * from './agent-home-history';
import {
  AGENT_HOME_NOT_IMPORTED, AGENT_HOME_IMPORT_REQUIRED } from '../../../workspace-server/agent-config/homes';

const disk: typeof fs = process.versions.electron
  ? (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).promises : fs;
export const AGENT_HOME_MARKER = '.gugu-agent-home.json';
export const AGENT_HOME_PENDING = '.gugu-agent-home.pending.json';
const FILE_LIMIT = 50 * 1024 * 1024;

export class AgentHomeNotImported extends Error {
  readonly code: typeof AGENT_HOME_NOT_IMPORTED | typeof AGENT_HOME_IMPORT_REQUIRED;
  constructor(readonly providerId: string, options?: ErrorOptions & { choiceRequired?: boolean }) {
    super(`In Settings → Subscriptions, import local configuration or sign in to ${providerId}. On a server, run gugu-server agent-home import ${providerId} to import, or use its sign-in flow if you chose Skip.`, options);
    this.name = 'AgentHomeNotImported';
    this.code = options?.choiceRequired ? AGENT_HOME_IMPORT_REQUIRED : AGENT_HOME_NOT_IMPORTED;
  }
}
export type AgentHomeImportStage = 'configuration' | 'history' | 'sign-in' | 'marker';

export class AgentHomeMigrationFailure extends Error {
  constructor(readonly stage: AgentHomeImportStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Harness configuration migration failed', { cause });
    this.name = 'AgentHomeMigrationFailure';
  }
}

export type AgentHomeImportIssue = {
  path: string;
  reason:
    | 'symlink' | 'sensitive' | 'database' | 'tooLarge' | 'sourceChanged' | 'unreadable'
    | 'excluded' | 'historyLimit';
};
export type AgentHistoryImportSummary = { imported: number; skipped: number; sessionBytes: number; limitBytes: number };
export type AgentHomeMarker = {
  historyImport?: AgentHistoryImportSummary;
  importedAt: string;
  sourceRoot: string;
  groups: AgentHomeGroupId[];
  files: Record<string, string>;
  migratedFrom?: 'shared';
  skipped?: true;
  terminalNeedsSignIn?: boolean;
  oldSessionsSkipped?: number;
  upgradeIssues?: AgentHomeImportIssue[];
  upgradeSignIn?: 'copied' | 'relogin';
  legacyBaseline?: boolean;
};
type PathSpec = Exclude<AgentHomeImportPath, string>;
type Item = {
  id: string; path: string; target: string; group: AgentHomeGroupId; spec: PathSpec;
  hash: string; mode: number; count: number; mcpCount: number;
  linkTarget?: string;
  sourceFile?: string; sourceRoot?: string;
};
type SnapshotItem = Item & { bytes: Buffer };
export type AgentHomeDiffState =
  | 'unchanged' | 'userChanged' | 'guguChanged' | 'bothChanged' | 'userAdded' | 'userDeleted';
export type AgentHomeDiffEntry = { id: string; path: string; group: AgentHomeGroupId; state: AgentHomeDiffState; uncertain?: boolean; revision: string;
};

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

async function realSource(path: string): Promise<string> {
  try { return await disk.realpath(path); }
  catch (error) { if (missing(error)) return path; throw error; }
}

/** Reject links below the canonical source or the private destination. */
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

export function initializeManagedAgentHome(home: ResolvedAgentHome): Promise<void> {
  return makeDirectory(home, home.configRoot);
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
  if (error instanceof AgentHomeSensitiveLinkError) return { path, reason: 'sensitive' };
  const code = (error as NodeJS.ErrnoException).code;
  return { path, reason: code === 'ELOOP' ? 'symlink' : code === 'EFBIG' ? 'tooLarge' : code === 'ESTALE' ? 'sourceChanged' : 'unreadable' };
}

function importDeclarations(home: ResolvedAgentHome, groups?: ReadonlySet<AgentHomeGroupId>) {
  return home.importGroups.filter((group) => !groups || groups.has(group.id)).flatMap((group) =>
    group.paths.map((path) => {
      const spec = normalize(path);
      return { group: group.id, spec, path: localPath(spec.path, true) };
    }));
}

function matchesPath(path: string, declared: string): boolean {
  return path === declared || path.startsWith(`${declared}/`);
}

async function collect(home: ResolvedAgentHome, options: {
  root?: string;
  strict?: (item: { group: AgentHomeGroupId; id: string }) => boolean;
  groups?: ReadonlySet<AgentHomeGroupId>;
  consume?: (items: SnapshotItem[]) => Promise<void>;
} = {}) {
  const items: Item[] = [], issues: AgentHomeImportIssue[] = [];
  const mcpSecrets = new Set<string>();
  const mcpNames = new Set<string>();
  let projectMcpCount = 0;
  let newestMtime = 0;
  const declarations = importDeclarations(home, options.groups);
  const root = options.root ?? (await realSource(home.userConfigRoot));
  const seen = new Set<string>();
  const visit = async (path: string, boundary: string, depth: number): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    const full = resolve(boundary, path.startsWith('../') ? basename(path) : path);
    if (excluded(path, home.credentialPaths)) {
      issues.push({ path, reason: 'sensitive' }); return;
    }
    if (excluded(path, home.carryExclusions)) { issues.push({ path, reason: 'excluded' }); return; }
    const stat = await (async () => {
      await noLinks(boundary, dirname(full));
      return disk.lstat(full);
    })().catch((error: unknown) => {
      if (!missing(error)) {
        issues.push(issue(path, error));
      }
      return null;
    });
    if (!stat) { if (depth > 0) issues.push({ path, reason: 'sourceChanged' }); return; }
    const selected = declarations.filter((entry) => matchesPath(path, entry.path));
    const projectLink = stat.isSymbolicLink() && selected.some(({ spec }) => spec.keys || spec.omitKeys);
    if (stat.isSymbolicLink() && !projectLink) {
      let linkSnapshots: SnapshotItem[];
      try {
        const linkTarget = await importedLinkTarget(
          home,
          full,
          declarations.map((entry) => entry.path),
          root
        );
        linkSnapshots = selected.map(({ group, spec }) => ({
          id: itemId(path, spec),
          path,
          target: localPath(spec.target ?? path),
          group,
          spec,
          hash: hash('symlink:' + linkTarget),
          mode: stat.mode & 0o777,
          count: 1,
          mcpCount: 0,
          linkTarget,
          bytes: Buffer.alloc(0)
        }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw error;
        issues.push(issue(path, error));
        return;
      }
      items.push(...linkSnapshots);
      if (linkSnapshots.length) newestMtime = Math.max(newestMtime, stat.mtimeMs);
      await options.consume?.(linkSnapshots);
      return;
    }
    if (stat.isDirectory()) {
      const children = await disk.readdir(full).catch((error: unknown) => {
        if (!missing(error)) {
            issues.push(issue(path, error));
        }
        return [];
      });
      for (const name of children.sort()) await visit(`${path}/${name}`, boundary, depth + 1);
      return;
    }
    if (!stat.isFile() && !projectLink) {
      issues.push({ path, reason: 'unreadable' });
      return;
    }
    const snapshots: SnapshotItem[] = [];
    const declared = selected.some((entry) => entry.path === path);
    const wholeTree = !projectLink && selected.some(
      (entry) =>
        path.startsWith(entry.path.replace(/\/$/, '') + '/') &&
        !entry.spec.keys &&
        !entry.spec.omitKeys
    );
    const strict = selected.some((entry) => entry.path === path && options.strict?.({ group: entry.group, id: itemId(path, entry.spec) }));
    try {
      // Project linked documents into regular files so unselected fields cannot cross the import boundary.
      const input = projectLink ? (await resolveAgentHomeImportLink(home, full, root)).resolved : full;
      if (input === null) { issues.push({ path, reason: 'sourceChanged' }); return; }
      const inputStat = projectLink ? await disk.lstat(input) : stat;
      if (projectLink) {
        const targetRel = relative(root, input).split(sep).join('/');
        if (excluded(targetRel, home.carryExclusions)) { issues.push({ path, reason: 'excluded' }); return; }
        if (!inputStat.isFile()) { issues.push({ path, reason: 'unreadable' }); return; }
      }
      if (!wholeTree && inputStat.size > FILE_LIMIT) { issues.push({ path, reason: 'tooLarge' }); return; }
      if (wholeTree && stat.size > FILE_LIMIT) {
        const digest = await streamImportFile(full, undefined, undefined, boundary);
        for (const { group, spec } of selected) {
          const item: SnapshotItem = {
            id: itemId(path, spec),
            path,
            target: localPath(spec.target ?? path),
            group,
            spec,
            hash: digest,
            mode: stat.mode & 0o777,
            count: 1,
            mcpCount: 0,
            sourceFile: full, sourceRoot: boundary,
            bytes: Buffer.alloc(0)
          };
          items.push(item);
          snapshots.push(item);
        }
      }
      const content = snapshots.length ? null : await snapshot(projectLink ? dirname(input) : boundary, input);
      if (projectLink && await disk.realpath(full) !== input) { issues.push({ path, reason: 'sourceChanged' }); return; }
      if (!content && !snapshots.length) { issues.push({ path, reason: 'sourceChanged' }); return; }
      if (content) {
        if (/\.(?:json|toml)$/.test(path)) {
        try {
          const doc = parseDocument(content, path);
          const servers = doc.mcpServers ?? doc.mcp_servers;
          if (object(servers)) for (const [name, server] of Object.entries(servers)) {
            mcpNames.add(name);
            if (object(server) && (object(server.env) || object(server.headers)
              ||
                    (Array.isArray(server.args) && server.args.some((arg: unknown) => typeof arg === 'string' && /(?:--(?:api[-_]?key|token|secret|password)|(?:sk|key)-[a-z0-9]{12})/i.test(arg
                          )
                      )))) mcpSecrets.add(name);
          }
          if (object(doc.projects)) for (const project of Object.values(doc.projects)) {
            if (object(project) && object(project.mcpServers)) projectMcpCount += Object.keys(project.mcpServers).length;
          }
        } catch (error) { if (declared) throw error; }
      }
      for (const { group, spec } of selected) {
        const target = localPath(spec.target ?? path);
        const projected = project(content, spec, group);
        let count = (!spec.keys && !spec.omitKeys) || projected.toString('utf8') !== '{}' ? 1 : 0;
        let mcpCount = 0;
        if (/\.(?:json|toml)$/.test(path)) {
          try {
            const doc = parseDocument(projected, path), servers = doc.mcpServers ?? doc.mcp_servers;
            mcpCount = object(servers) ? Object.keys(servers).length : 0;
            if (group === 'mcp') count = mcpCount;
            if (group === 'hooks') count = Array.isArray(doc.hooks) ? doc.hooks.length : object(doc.hooks) ? Object.values(doc.hooks).reduce<number>((total, hooks) => total + (Array.isArray(hooks)
              ? hooks.reduce<number>((sum, entry: unknown) => sum + (object(entry) && Array.isArray(entry.hooks) ? entry.hooks.length : 1), 0) : 0), 0) : 0;
          } catch { /* Unprojected files may be arbitrary user content. */ }
        }
        const item: Item = { id: itemId(path, spec), path, target, group, spec, hash: hash(projected), mode: inputStat.mode & 0o777, count, mcpCount };
        items.push(item);
        snapshots.push({ ...item, bytes: projected });
      }
    }
    if (snapshots.length) newestMtime = Math.max(newestMtime, inputStat.mtimeMs);
    } catch (error) {
      if (!missing(error)) {
        const rejected = issue(path, error);
        if (strict && rejected.reason === 'unreadable') throw new Error(`Cannot read declared configuration file ${path}; repair the file and retry the import`);
        issues.push(rejected);
      }
    }
    // Source failures are listed; destination writes and stale choices must fail the operation.
    // Keep at most one bounded source file in memory; large tree assets are streamed.
    if (snapshots.length) {
      await options.consume?.(snapshots);
    }
  };
  const paths = [...new Set(declarations.map((entry) => entry.path))].sort();
  const parent = paths.some((path) => path.startsWith('../')) ? await realSource(dirname(home.userConfigRoot)) : root;
  for (const path of paths) await visit(path, path.startsWith('../') ? parent : root, 0);
  return { items, issues, newestMtime, mcpSecrets: [...mcpSecrets], mcpNames: [...mcpNames], projectMcpCount };
}

export async function readAgentHomeMarker(home: ResolvedAgentHome, filename = AGENT_HOME_MARKER): Promise<AgentHomeMarker | null> {
  try {
    const markerPath = join(home.shadowHome, filename);
    if (!(await disk.lstat(markerPath)).isFile()) throw new Error('Managed configuration import record is not a file');
    const bytes = await snapshot(home.shadowHome, markerPath);
    if (!bytes) return null;
    await makeDirectory(home, home.configRoot);
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (filename === AGENT_HOME_MARKER && object(value) && value.seed === 'copied' && !value.importedAt) {
      const legacy: AgentHomeMarker = {
        importedAt: new Date((await disk.stat(join(home.shadowHome, AGENT_HOME_MARKER))).mtimeMs).toISOString(),
        sourceRoot: home.userConfigRoot, groups: home.importGroups.map((group) => group.id),
        files: {}, legacyBaseline: true
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
export function readAgentHomePending(home: ResolvedAgentHome): Promise<AgentHomeMarker | null> {
  return readAgentHomeMarker(home, AGENT_HOME_PENDING);
}
async function writeMarker(home: ResolvedAgentHome, marker: AgentHomeMarker, filename = AGENT_HOME_MARKER): Promise<void> {
  const destination = join(home.shadowHome, filename), temporary = `${destination}.${randomUUID()}`;
  await disk.writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { await disk.rename(temporary, destination); }
  finally { await disk.rm(temporary, { force: true }); }
}
async function writeItem(
  home: ResolvedAgentHome, items: SnapshotItem[], mode: 'import' | 'upgrade' | 'repair' | 'reimport',
  guard?: (current: Buffer | null, currentHash?: string) => void
): Promise<void> {
  const target = join(home.configRoot, items[0]!.target);
  await makeDirectory(home, dirname(target));
  const first = items[0]!;
  if (first.linkTarget !== undefined || first.sourceFile) {
    const before = await currentItemHash(home, first.target, first.spec);
    guard?.(null, before);
    if (before === first.hash) return;
    if (before && mode !== 'reimport')
      throw new Error('Managed configuration already differs at ' + first.target);
    const temporary = target + '.' + randomUUID();
    try {
      if (first.linkTarget !== undefined)
        await disk.symlink(
          first.linkTarget,
          temporary,
          await disk.stat(resolve(home.userConfigRoot, first.path)).then(
            (stat) => (stat.isDirectory() ? 'dir' : 'file'),
            () => 'file'
          )
        );
      else await streamImportFile(first.sourceFile!, temporary, first.hash, first.sourceRoot);
      if ((await currentItemHash(home, first.target, first.spec)) !== before)
        throw new Error('Managed configuration changed; retry import');
      await disk.rename(temporary, target);
    } finally {
      await disk.rm(temporary, { force: true });
    }
    return;
  }
  const projected = items.some((item) => item.spec.keys || item.spec.omitKeys);
  const existing = await snapshot(home.configRoot, target);
  guard?.(existing);
  if (existing && mode !== 'reimport') {
    const conflict = items.find((item) => {
      const managed = project(existing, item.spec, item.group);
      if (hash(managed) === item.hash) return false;
      if (mode === 'upgrade' && item.spec.isLegacyGeneratedTarget?.(existing.toString('utf8'))) return false;
      if (mode === 'repair' || !projected) return true;
      const incoming = parseDocument(item.bytes, item.spec.path);
      const current = parseDocument(managed, item.spec.path);
      return Object.keys(incoming).some((key) => Object.hasOwn(current, key) && stable(current[key]) !== stable(incoming[key]));
    });
    if (conflict) throw new Error(`Managed configuration already differs at ${conflict.target}; review the differences in Settings → Subscriptions before importing`);
    if (items.every((item) => hash(project(existing, item.spec, item.group)) === item.hash)) return;
  }
  let bytes = items[0]!.bytes;
  if (projected) {
    // A CLI may have written defaults while it was being discovered. Add selected values
    // without removing unrelated runtime settings on the first import.
    const current = existing ? parseDocument(existing, target) : {};
    for (const item of items) {
      const subset = parseDocument(item.bytes, item.spec.path);
      if (mode === 'reimport') {
        if (item.spec.keys) for (const key of item.spec.keys) delete current[key];
        else for (const key of Object.keys(current)) if (!item.spec.omitKeys?.includes(key)) delete current[key];
      }
      if (object(subset)) Object.assign(current, subset);
    }
    bytes = Buffer.from(target.endsWith('.toml') ? toml.stringify(current) : `${JSON.stringify(current, null, 2)}\n`);
  }
  if (!existing) {
    await disk.writeFile(target, bytes, { mode: items[0]!.mode, flag: 'wx' });
    return;
  }
  await noLinks(home.configRoot, target).catch((error: unknown) => { if (!missing(error)) throw error; });
  const temporary = `${target}.${randomUUID()}`;
  await disk.writeFile(temporary, bytes, { mode: items[0]!.mode, flag: 'wx' });
  try {
    const current = await snapshot(home.configRoot, target);
    if (!current?.equals(existing)) throw new Error('Managed configuration changed; review the differences before importing');
    await disk.rename(temporary, target);
  }
  finally { await disk.rm(temporary, { force: true }); }
}
async function currentItemHash(
  home: ResolvedAgentHome,
  path: string,
  spec: PathSpec,
  group?: AgentHomeGroupId
): Promise<string | undefined> {
  const target = join(home.configRoot, path);
  await noLinks(home.configRoot, dirname(target)).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  const stat = await disk.lstat(target).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) return hash('symlink:' + (await disk.readlink(target)));
  if (stat.size > FILE_LIMIT && !spec.keys && !spec.omitKeys) return streamImportFile(target, undefined, undefined, home.configRoot);
  const bytes = await snapshot(home.configRoot, target);
  return bytes ? hash(project(bytes, spec, group)) : undefined;
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
  // The import records hashes of its selected projections, not CLI runtime activity.
  // Ignore unticked groups and metadata changes (including sibling-file runtime keys).
  const imported = marker ? items.filter(item => marker.groups.includes(item.group)) : [];
  const source = new Map(imported.map(item => [item.id, item.hash]));
  const sourceUpdated = !!marker && !marker.skipped && (marker.legacyBaseline
    // Old copied homes have no hashes. Keep their signal, restricted to importable files.
    ? (await collect(home, { groups: new Set(marker.groups) })).newestMtime > Date.parse(marker.importedAt)
    : imported.some(item => marker.files[item.id] !== item.hash)
      || Object.keys(marker.files).some(id => !source.has(id) && !issues.some(issue => matchesPath(id.split('#')[0]!, issue.path))));
  return {
    providerId: home.providerId, userRoot: home.userConfigRoot, marker, newestMtime, sourceUpdated,
    groups: home.importGroups.map((group) => {
      const members = items.filter((item) => item.group === group.id);
      return { id: group.id, count: groupCount(members, group.id), mcpCount: members.reduce((count, item) => count + item.mcpCount, 0) };
    }),
    issues,
    mcpSecrets, mcpNames, projectMcpCount
  };
}
type AgentHomeImportOptions = {
  groups: ReadonlySet<AgentHomeGroupId>; now?: Date; migratedFrom?: 'shared';
  historyPaths?: readonly string[];
  historyIssues?: readonly AgentHomeImportIssue[];
  skip?: boolean;
  upgradeSummary?: (issues: readonly AgentHomeImportIssue[]) => Pick<AgentHomeMarker, 'oldSessionsSkipped' | 'upgradeIssues' | 'historyImport'>;
  prepareAfterPublish?: () => Promise<void>;
  afterCommit?: () => Promise<Pick<AgentHomeMarker, 'upgradeSignIn' | 'terminalNeedsSignIn'> | void>;
};

async function stageAgentHomeUpgrade<T>(home: ResolvedAgentHome, apply: (target: ResolvedAgentHome) => Promise<T>): Promise<T> {
  const parent = dirname(home.shadowHome);
  const backup = `${home.shadowHome}.gugu-upgrade-previous`;
  const stat = (path: string) => disk.lstat(path).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  let current = await stat(home.shadowHome);
  const previous = await stat(backup);
  if (previous) {
    if (current || !previous.isDirectory()) throw new Error('Managed configuration has an unresolved upgrade backup');
    await disk.rename(backup, home.shadowHome);
    current = previous;
  }
  if (current && !current.isDirectory()) throw new Error('Managed configuration root is not a directory');
  await disk.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await disk.mkdtemp(join(parent, '.gugu-upgrade-'));
  try {
    if (current) await disk.cp(home.shadowHome, temporary, {
      recursive: true, dereference: false, verbatimSymlinks: true
      });
    const result = await apply({ ...home, shadowHome: temporary, configRoot: join(temporary, relative(home.shadowHome, home.configRoot)) });
    const latest = await stat(home.shadowHome);
    if (current?.ino !== latest?.ino || current?.dev !== latest?.dev) throw new Error('Managed configuration root changed during upgrade');
    if (current) await disk.rename(home.shadowHome, backup);
    try { await disk.rename(temporary, home.shadowHome); }
    catch (error) {
      if (current) await disk.rename(backup, home.shadowHome);
      throw error;
    }
    if (current) await disk.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return result;
  } finally {
    await disk.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function importAgentHome(home: ResolvedAgentHome, options: AgentHomeImportOptions): Promise<{ marker: AgentHomeMarker; issues: AgentHomeImportIssue[] }> {
  let stage: AgentHomeImportStage = 'marker';
  try {
    const originalMarker = await readAgentHomeMarker(home);
    if (originalMarker && (!originalMarker.skipped || !options.groups.size)) return { marker: originalMarker, issues: [] };
    const pendingMarker = options.prepareAfterPublish ? await readAgentHomePending(home) : null;
    if (options.migratedFrom && !pendingMarker)
      await checkAgentHomeImportSpace([
        { home, groups: options.groups, historyPaths: options.historyPaths }
      ]);
    const apply = async (target: ResolvedAgentHome) => {
      const existing = target === home ? originalMarker : await readAgentHomeMarker(target);
      if (existing && (!existing.skipped || !options.groups.size)) return { marker: existing, issues: [] };
      stage = 'configuration';
      if (existing?.skipped) {
        const { entries } = await diffAgentHome(target);
        const conflict = entries.find((entry) => options.groups.has(entry.group) && entry.state === 'bothChanged');
        if (conflict) throw new Error(`Managed configuration already differs at ${conflict.path}; review the differences in Settings → Subscriptions before importing`);
      }
      await makeDirectory(target, target.configRoot);
      const root = options.groups.size || options.historyPaths?.length ? await realSource(home.userConfigRoot) : home.userConfigRoot;
      const { items, issues } = options.groups.size ? await collect(target, {
        root, groups: options.groups, strict: () => true,
        consume: async (snapshots) => {
          for (const entries of byTarget(snapshots)) {
            const mode = existing?.skipped ? 'repair' : options.migratedFrom === 'shared' ? 'upgrade' : 'import';
            await writeItem(target, entries, mode);
          }
        }
          }) : { items: [] as Item[], issues: [] as AgentHomeImportIssue[] };
      stage = 'history';
      if (options.historyPaths?.length) issues.push(...(await copyAgentHomeHistory(target, options.historyPaths, root)));
      issues.push(...options.historyIssues ?? []);
      const marker: AgentHomeMarker = {
        importedAt: (options.now ?? new Date()).toISOString(), sourceRoot: home.userConfigRoot,
        groups: [...options.groups], files: Object.fromEntries(items.map((item) => [item.id, item.hash])),
        ...(options.skip ? { skipped: true as const } : {}),
        ...(options.migratedFrom ? { migratedFrom: options.migratedFrom } : {}),
        ...options.upgradeSummary?.(issues)
      };
      stage = 'marker';
      if (options.prepareAfterPublish) {
        await writeMarker(target, marker, AGENT_HOME_PENDING);
        if (existing?.skipped) await disk.rm(join(target.shadowHome, AGENT_HOME_MARKER), { force: true });
      } else await writeMarker(target, marker);
      return { marker, issues };
    };
    const result = pendingMarker ? { marker: pendingMarker, issues: pendingMarker.upgradeIssues ?? [] }
      : options.migratedFrom ? await stageAgentHomeUpgrade(home, apply) : await apply(home);
    stage = 'history';
    // Native indexes contain absolute paths, so initialize only after publication at the final root.
    await options.prepareAfterPublish?.();
    stage = 'sign-in';
    // Path-scoped credentials (for example Keychain) must use the final managed home.
    const upgrade = await options.afterCommit?.();
    if (!upgrade && !options.prepareAfterPublish) return result;
    stage = 'marker';
    const marker = { ...result.marker, ...upgrade };
    await writeMarker(home, marker);
    if (options.prepareAfterPublish) await disk.rm(join(home.shadowHome, AGENT_HOME_PENDING), { force: true });
    return { ...result, marker };
  } catch (error) {
    if (options.migratedFrom) throw new AgentHomeMigrationFailure(stage, error);
    throw error;
  }
}

/** Stream resumable transcripts separately from the configuration-file budget. */
export async function copyAgentHomeHistory(home: ResolvedAgentHome, paths: readonly string[], sourceRoot?: string, signal?: AbortSignal): Promise<AgentHomeImportIssue[]> {
  const root = sourceRoot ?? (await realSource(home.userConfigRoot));
  const issues: AgentHomeImportIssue[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (excluded(path, home.credentialPaths)) { issues.push({ path, reason: 'sensitive' }); return; }
    const source = join(root, localPath(path)), target = join(home.configRoot, localPath(path));
    let created = false;
    try {
      await noLinks(root, dirname(source));
      const before = await disk.lstat(source);
      if (before.isSymbolicLink()) {
        const link = await importedLinkTarget(home, source, paths, root);
        await makeDirectory(home, dirname(target));
        try {
          await disk.symlink(
            link,
            target,
            await disk.stat(source).then(
              (stat) => (stat.isDirectory() ? 'dir' : 'file'),
              () => 'file'
            )
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (
            !(await disk.lstat(target)).isSymbolicLink() ||
            (await disk.readlink(target)) !== link
          )
            issues.push({ path, reason: 'sourceChanged' });
        }
        return;
      }
      if (before.isDirectory()) {
        for (const name of (await disk.readdir(source)).sort()) await visit(`${path}/${name}`, depth + 1);
        return;
      }
      if (!before.isFile()) {
        issues.push({ path, reason: 'unreadable' });
        return;
      }
      const input = await disk.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await input.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev) throw Object.assign(new Error('Source changed'), { code: 'ESTALE' });
        await makeDirectory(home, dirname(target));
        let output;
        try { output = await disk.open(target, 'wx', before.mode & 0o777); created = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            if (
              (await disk.stat(target)).size !== before.size ||
              (await streamImportFile(target)) !== (await streamImportFile(source))
            )
              issues.push({ path, reason: 'sourceChanged' });
            return;
          }
          throw error; }
        let read = 0;
        try {
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            signal?.throwIfAborted();
            const result = await input.read(buffer, 0, buffer.length, null);
            if (!result.bytesRead) break;
            if (read + result.bytesRead > before.size) throw Object.assign(new Error('Source changed'), { code: 'ESTALE' });
            let written = 0;
            while (written < result.bytesRead) {
              written += (await output.write(buffer, written, result.bytesRead - written, null)).bytesWritten;
            }
            read += result.bytesRead;
          }
        } finally { await output.close(); }
        const after = await input.stat();
        await noLinks(root, source);
        const current = await disk.lstat(source);
        if (read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) throw Object.assign(new Error('Source changed'), { code: 'ESTALE' });
      } finally { await input.close(); }
    } catch (error) {
      if (created) await disk.rm(target, { force: true });
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw error;
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
  const declarations = importDeclarations(home);
  for (const id of new Set([...Object.keys(marker.files), ...source.keys()])) {
    const item = source.get(id), path = item?.path ?? id.split('#')[0]!;
    const declaration = item ?? declarations.find((entry) => matchesPath(path, entry.path) && itemId(path, entry.spec) === id);
    // Older markers can reference files which are outside the current import allowlist.
    if (!declaration) continue;
    const { group, spec } = declaration;
    const target = localPath(item?.target ?? spec.target ?? path);
    let managedHash: string | undefined;
    try {
      managedHash = await currentItemHash(home, target, spec, group);
    } catch (error) { issues.push(issue(path, error)); continue; }
    const base = marker.files[id];
    // A rejected source is unreadable, never proof of a deletion.
    if (!item && issues.some((entry) => path === entry.path || path.startsWith(`${entry.path}/`))) continue;
    const uncertain = !base && marker.legacyBaseline === true;
    const state: AgentHomeDiffState = !item ? 'userDeleted' : !base
      ? managedHash === item.hash ? 'unchanged' : managedHash || uncertain ? 'bothChanged' : 'userAdded'
      : item.hash === base ? managedHash === base ? 'unchanged' : 'guguChanged'
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
  const { items, issues } = await collect(home, {
    strict: ({ id }) => allowed.has(id),
    consume: async (snapshots) => {
      for (const entries of byTarget(snapshots.filter((item) => allowed.has(item.id)))) {
        await writeItem(home, entries, 'reimport', (current, currentHash) => {
          for (const item of entries) {
            const managed =
                currentHash ??
                (current ? hash(project(current, item.spec, item.group)) : undefined);
            if (revisions.get(item.id) !== hash(stable({ base: marker.files[item.id], user: item.hash, managed }))) {
              throw new Error('Configuration changed; review the differences again before importing');
            }
          }
        });
      }
    }
    }), selected = items.filter((item) => allowed.has(item.id));
  if (selected.length !== allowed.size) throw new Error('Configuration changed; review the differences again before importing');
  for (const item of selected) marker.files[item.id] = item.hash;
  marker.groups = [...new Set([...marker.groups, ...selected.map((item) => item.group)])];
  if (selected.length) delete marker.skipped;
  await writeMarker(home, marker);
  return { issues: [...diff.issues, ...issues], imported: selected.length };
}

/** Migration-only edit, guarded by the same safe read and an optimistic content check. */
export async function updateAgentHomeSource(
  home: ResolvedAgentHome, path: string,
  update: (fs: Pick<PluginFs, 'read' | 'write'>, path: string) => Promise<void>
): Promise<AgentHomeImportIssue | undefined> {
  const root = await realSource(home.userConfigRoot);
  const target = join(root, localPath(path));
  let before: Buffer | null;
  try { before = await snapshot(root, target); }
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
    const current = await snapshot(root, target);
    if (!current || hash(current) !== hash(before)) throw new Error('Source changed; retry migration');
    await disk.rename(temporary, target);
  } finally { await disk.rm(temporary, { force: true }); }
}
