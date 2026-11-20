import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ResolvedAgentHome } from '@gugu/session-core/agents/plugins';
import { KeyedMutex } from '@gugu/session-core/lib';
import {
  AgentHomeSensitiveLinkError, diffAgentHome, importAgentHome, importedLinkTarget, readAgentHomeMarker,
  reimportAgentHome, resolveAgentHomeImportLink, streamImportFile,
} from '@gugu/session-core/agents/plugins/helpers';

const disk: typeof fs = process.versions.electron
  ? createRequire(import.meta.url)('original-fs').promises : fs;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');
const claims = new KeyedMutex();
const FILE_LIMIT = 50 * 1024 * 1024;

export type CodexMemoryReason = 'unreadable' | 'too-large' | 'sensitive-link' | 'invalid-cwd'
  | 'missing-directory' | 'target-differs' | 'source-changed' | 'unknown-source' | 'write-failed';
export type CodexMemoryItem = {
  localSourceId: string;
  fingerprint: string | null;
  kind: 'memory';
  name: string;
  scope: 'global' | 'project';
  cwd?: string;
  updatedAt?: string;
  status: 'ready' | 'exists' | 'skipped' | 'conflict' | 'imported' | 'failed';
  reason?: CodexMemoryReason;
  target: { providerId: 'codex'; paths: string[]; cwd?: string };
  /** Relative native paths, never source contents. A personal bundle stays one item. */
  sourcePaths: string[];
  importedPaths?: string[];
};
export type CodexMemorySelection = { localSourceId: string; fingerprint: string };
type Options = { home: ResolvedAgentHome; signal?: AbortSignal };
type FileState = { path: string; hash: string; contentHash: string; targetHash?: string };
type Candidate = { item: CodexMemoryItem; files: FileState[] };

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
async function managedHome(home: ResolvedAgentHome): Promise<ResolvedAgentHome> {
  if (home.providerId !== 'codex' || !isAbsolute(home.shadowHome) || !isAbsolute(home.configRoot)
    || !isAbsolute(home.userConfigRoot) || !isAbsolute(home.osHomeDir)
    || home.shadowHome === home.configRoot || !inside(home.shadowHome, home.configRoot)) {
    throw new Error('A resolved managed Codex home is required');
  }
  const source = await disk.realpath(home.userConfigRoot).catch((error: unknown) => {
    if (missing(error)) return resolve(home.userConfigRoot);
    throw error;
  });
  const target = await disk.realpath(home.configRoot).catch((error: unknown) => {
    if (missing(error)) return resolve(home.configRoot);
    throw error;
  });
  if (inside(source, target) || inside(target, source)) throw new Error('Managed memories must be separate from their source');
  return { ...home, userConfigRoot: source };
}
function selectedHome(home: ResolvedAgentHome, paths: readonly string[]): ResolvedAgentHome {
  return { ...home, importGroups: [{ id: 'rules', paths: [...paths], evidence: 'Selected native Codex memory source files.' }] };
}
async function exists(path: string): Promise<boolean> {
  try { await disk.lstat(path); return true; }
  catch (error) { if (missing(error)) return false; throw error; }
}
async function targetHash(home: ResolvedAgentHome, path: string, signal?: AbortSignal): Promise<string | undefined> {
  const file = join(home.configRoot, path);
  try {
    const stat = await disk.lstat(file);
    // Hash a link's identity without following an arbitrary managed target.
    if (stat.isSymbolicLink()) return hash(`symlink:${await disk.readlink(file)}`);
    return await streamImportFile(file, undefined, undefined, home.configRoot, signal);
  } catch (error) { signal?.throwIfAborted(); if (missing(error)) return; throw error; }
}
async function sourceFile(home: ResolvedAgentHome, path: string, paths: readonly string[], signal?: AbortSignal): Promise<FileState> {
  signal?.throwIfAborted();
  const file = join(home.userConfigRoot, path);
  const stat = await disk.lstat(file);
  let digest: string;
  let contentHash: string;
  if (stat.isSymbolicLink()) {
    const link = await resolveAgentHomeImportLink(home, file, home.userConfigRoot);
    if (!link.resolved) throw new Error('Memory link target is missing');
    contentHash = await streamImportFile(link.resolved, undefined, undefined, dirname(link.resolved), signal);
    digest = hash(`symlink:${await importedLinkTarget(home, file, paths, home.userConfigRoot)}`);
  } else {
    if (!stat.isFile()) throw new Error('Memory source is not a file');
    if (stat.size > FILE_LIMIT) throw Object.assign(new Error('Memory source is too large'), { code: 'EFBIG' });
    digest = contentHash = await streamImportFile(file, undefined, undefined, home.userConfigRoot, signal);
  }
  return { path, hash: digest, contentHash, targetHash: await targetHash(home, path, signal) };
}
async function header(home: ResolvedAgentHome, path: string, signal?: AbortSignal): Promise<{ cwd?: string; updatedAt?: string }> {
  const file = join(home.userConfigRoot, path);
  const stat = await disk.lstat(file);
  const source = stat.isSymbolicLink() ? (await resolveAgentHomeImportLink(home, file, home.userConfigRoot)).resolved : file;
  if (!source) return {};
  const handle = await disk.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    signal?.throwIfAborted();
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (bytesRead === buffer.length) text = text.slice(0, text.lastIndexOf('\n') + 1);
    const cwd = /^(?:cwd|working_directory):[ \t]*(.+)$/m.exec(text)?.[1]?.trim();
    const updatedAt = /^(?:updated_at|timestamp):[ \t]*(.+)$/m.exec(text)?.[1]?.trim();
    return { cwd, updatedAt };
  } finally { await handle.close(); }
}
function reason(error: unknown): CodexMemoryReason {
  const code = (error as NodeJS.ErrnoException)?.code;
  return error instanceof AgentHomeSensitiveLinkError ? 'sensitive-link'
    : code === 'EFBIG' ? 'too-large' : code === 'ESTALE' ? 'source-changed' : 'unreadable';
}

async function candidates(options: Options): Promise<{ home: ResolvedAgentHome; paths: string[]; entries: Candidate[] }> {
  options.signal?.throwIfAborted();
  const home = await managedHome(options.home);
  const personal: string[] = [];
  try {
    if ((await disk.lstat(join(home.userConfigRoot, 'memories'))).isSymbolicLink()) {
      throw new Error('Linked memory directory is not imported');
    }
  } catch (error) { if (!missing(error)) throw error; }
  if (await exists(join(home.userConfigRoot, 'AGENTS.md'))) personal.push('AGENTS.md');
  const summary = 'memories/memory_summary.md';
  const fallback = 'memories/MEMORY.md';
  if (await exists(join(home.userConfigRoot, summary))) personal.push(summary);
  else if (await exists(join(home.userConfigRoot, fallback))) personal.push(fallback);
  const directory = join(home.userConfigRoot, 'memories/rollout_summaries');
  let summaries: string[];
  try {
    // Do not traverse a substituted directory link, .git, or unrelated memory trees.
    if ((await disk.lstat(directory)).isSymbolicLink()) throw new Error('Linked memory directory is not imported');
    summaries = (await disk.readdir(directory)).filter(name => name.endsWith('.md')).sort()
      .map(name => `memories/rollout_summaries/${name}`);
  } catch (error) { if (missing(error)) summaries = []; else throw error; }
  const groups = [...(personal.length ? [{ paths: personal, scope: 'global' as const, key: 'personal', name: 'Personal memory' }] : []),
    ...summaries.map(path => ({ paths: [path], scope: 'project' as const, key: path, name: basename(path, '.md') }))];
  const paths = groups.flatMap(group => group.paths);
  const scoped = selectedHome(home, paths);
  const marker = await readAgentHomeMarker(scoped);
  const diff = marker ? await diffAgentHome(scoped, options.signal) : undefined;
  const entries: Candidate[] = [];
  for (const group of groups) {
    options.signal?.throwIfAborted();
    const item: CodexMemoryItem = {
      localSourceId: `codex:memory:${hash(JSON.stringify([home.userConfigRoot, group.key]))}`,
      fingerprint: null, kind: 'memory', name: group.name, scope: group.scope, status: 'ready',
      sourcePaths: group.paths, target: { providerId: 'codex', paths: group.paths.map(path => join(home.configRoot, path)) },
    };
    const files: FileState[] = [];
    try {
      for (const path of group.paths) files.push(await sourceFile(home, path, paths, options.signal));
      if (group.scope === 'project') {
        const metadata = await header(home, group.paths[0], options.signal);
        item.updatedAt = metadata.updatedAt;
        if (!metadata.cwd || !isAbsolute(metadata.cwd) || metadata.cwd.includes('\0')) {
          item.status = 'skipped'; item.reason = 'invalid-cwd';
        } else {
          item.cwd = await disk.realpath(metadata.cwd).catch((error: unknown) => {
            if (missing(error)) return resolve(metadata.cwd!);
            throw error;
          });
          item.target.cwd = item.cwd;
          if (!(await disk.stat(item.cwd).catch((error: unknown) => { if (missing(error)) return null; throw error; }))?.isDirectory()) {
            item.status = 'skipped'; item.reason = 'missing-directory';
          }
        }
      }
      const states = files.map(file => diff?.entries.find(entry => entry.id === file.path));
      const issue = diff?.issues.find(issue => group.paths.some(path => path === issue.path || path.startsWith(`${issue.path}/`)));
      item.fingerprint = hash(JSON.stringify([files.map(({ path, hash, contentHash }) => ({ path, hash, contentHash })),
        item.cwd, item.updatedAt]));
      if (item.status === 'ready') {
        if (issue) { item.status = 'skipped'; item.reason = 'unreadable'; }
        else if (states.some(state => state?.state === 'guguChanged' || state?.state === 'bothChanged')
          || files.some(file => !marker && file.targetHash !== undefined && file.targetHash !== file.hash)) {
          item.status = 'conflict'; item.reason = 'target-differs';
        } else if (files.every(file => file.targetHash === file.hash)) item.status = 'exists';
      }
    } catch (error) { options.signal?.throwIfAborted(); item.status = 'skipped'; item.reason = reason(error); }
    entries.push({ item, files });
  }
  return { home, paths, entries };
}

/** One personal bundle plus project summaries; no source bodies leave this service. */
export async function scanCodexMemories(options: Options): Promise<{ count: number; items: CodexMemoryItem[] }> {
  const { entries } = await candidates(options);
  return { count: entries.length, items: entries.map(entry => entry.item) };
}

/** Reuses the native rules importer and its existing optimistic target guards. */
export async function importCodexMemories(options: Options & {
  selection: readonly CodexMemorySelection[];
}): Promise<{ items: CodexMemoryItem[] }> {
  const home = await managedHome(options.home);
  const release = await claims.acquire(home.configRoot, options.signal);
  try {
    const scan = await candidates({ ...options, home });
    const byId = new Map(scan.entries.map(entry => [entry.item.localSourceId, entry]));
    const items: CodexMemoryItem[] = [];
    for (const selected of options.selection) {
      options.signal?.throwIfAborted();
      const entry = byId.get(selected.localSourceId);
      if (!entry) {
        items.push({ localSourceId: selected.localSourceId, fingerprint: selected.fingerprint, kind: 'memory', name: '',
          scope: 'global', status: 'conflict', reason: 'unknown-source', sourcePaths: [], target: { providerId: 'codex', paths: [] } });
        continue;
      }
      const result = { ...entry.item, importedPaths: [] as string[] };
      if (!entry.item.fingerprint || entry.item.fingerprint !== selected.fingerprint) {
        items.push({ ...result, status: 'conflict', reason: 'source-changed' });
        continue;
      }
      if (result.status !== 'ready') { items.push(result); continue; }
      const scoped = selectedHome(home, scan.paths);
      try {
        // This is the established Skip marker, with no imported groups/files.
        // Subsequent selected-file imports update the same marker, preserving all
        // prior settings, skills, credentials and rule-file baselines.
        if (!await readAgentHomeMarker(scoped)) {
          options.signal?.throwIfAborted();
          await importAgentHome(scoped, { groups: new Set(), skip: true });
        }
        for (const file of entry.files) {
          options.signal?.throwIfAborted();
          const diff = await diffAgentHome(scoped, options.signal);
          const revision = diff.entries.find(item => item.id === file.path);
          const current = await sourceFile(home, file.path, scan.paths, options.signal);
          if (!revision || revision.state === 'bothChanged' || revision.state === 'guguChanged'
            || JSON.stringify(current) !== JSON.stringify(file)) {
            result.status = 'conflict'; result.reason = 'source-changed'; break;
          }
          // One native file at a time: after publication its marker commits
          // before cancellation is observed at the next file/item boundary.
          const imported = await reimportAgentHome(scoped, new Set([file.path]), new Map([[file.path, revision.revision]]), options.signal);
          if (imported.issues.some(issue => issue.path === file.path)
            || await targetHash(home, file.path) !== file.hash) {
            result.status = 'failed'; result.reason = 'write-failed'; break;
          }
          result.importedPaths.push(file.path);
        }
        if (result.status === 'ready') result.status = 'imported';
      } catch (error) { options.signal?.throwIfAborted(); result.status = 'failed'; result.reason = 'write-failed'; }
      items.push(result);
    }
    return { items };
  } finally { release(); }
}
