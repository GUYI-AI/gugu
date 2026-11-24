import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import type { ResolvedAgentHome } from '@gugu/session-core/agents/plugins';
import {
  AgentHomeSensitiveLinkError, checkAgentHomeImportSpace, initializeManagedAgentHome, resolveAgentHomeImportLink,
  snapshotAgentHomeDirectory, streamImportFile, type AgentHomeDirectorySnapshot,
} from '@gugu/session-core/agents/plugins/helpers';

const disk: typeof fs = process.versions.electron
  ? createRequire(import.meta.url)('original-fs').promises : fs;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const FRONTMATTER_LIMIT = 1024 * 1024;

export type CodexSkillStatus = 'ready' | 'exists' | 'conflict' | 'skipped' | 'imported' | 'failed';
export type CodexSkillReason =
  | 'invalid-skill' | 'unreadable' | 'cyclic-link' | 'sensitive-link' | 'excluded'
  | 'same-name' | 'target-differs' | 'source-changed' | 'unknown-source' | 'write-failed';
export type CodexSkillItem = {
  localSourceId: string;
  kind: 'skill';
  scope: 'global';
  name: string;
  description: string;
  aliases: string[];
  fingerprint: string | null;
  target: string;
  status: CodexSkillStatus;
  reason?: CodexSkillReason;
  /** Importing resources does not install dependencies, authenticate tools or run a skill. */
  resources: { files: number; hasScripts: boolean; externalLinks: number };
};
export type CodexSkillSelection = { localSourceId: string; fingerprint: string };
export type CodexSkillScan = {
  count: number;
  items: CodexSkillItem[];
  counts: { codex: number; duplicates: number; custom: number };
  excludedRoots: { path: string; reason: 'built-in' | 'plugin-cache' | 'shared' }[];
};
type Options = { home: ResolvedAgentHome; signal?: AbortSignal };
type Candidate = { item: CodexSkillItem; source: string };

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return !part || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
}
/**
 * Codex's own skills folder. The shared `~/.agents/skills` is not a source: Codex reads it itself in the managed home too,
 * so a copy would list each of its skills twice.
 */
function sourceRoot(home: ResolvedAgentHome) {
  if (home.providerId !== 'codex' || !isAbsolute(home.shadowHome) || !isAbsolute(home.configRoot)
    || home.shadowHome === home.configRoot || !inside(home.shadowHome, home.configRoot)) {
    throw new Error('A resolved managed Codex home is required');
  }
  const source = join(home.userConfigRoot, 'skills');
  if (inside(source, home.configRoot) || inside(home.configRoot, source)) {
    throw new Error('Managed skills must be separate from their source');
  }
  return source;
}
async function names(path: string): Promise<string[]> {
  try { return (await disk.readdir(path)).sort(); }
  catch (error) { if (missing(error)) return []; throw error; }
}
function fingerprint(snapshot: AgentHomeDirectorySnapshot): string {
  return hash(JSON.stringify({ files: snapshot.files, directories: snapshot.directories }));
}
function issueReason(snapshot: AgentHomeDirectorySnapshot): CodexSkillReason | undefined {
  const issues = snapshot.issues.map(({ reason }) => reason);
  return issues.includes('sensitive') ? 'sensitive-link' : issues.includes('symlink') ? 'cyclic-link'
    : issues.includes('sourceChanged') ? 'source-changed' : issues.length ? 'unreadable' : undefined;
}
function stale(): Error { return Object.assign(new Error('Skill source changed'), { code: 'ESTALE' }); }

/** Bounded metadata read, checked against the shared migration reader's complete-file hash. */
async function metadata(root: string, snapshot: AgentHomeDirectorySnapshot, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const manifest = snapshot.files.find(({ path }) => path === 'SKILL.md');
  if (!manifest || manifest.linkTarget !== undefined) return null;
  const handle = await disk.open(join(root, 'SKILL.md'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    // A large instruction body is still a complete skill. Bound only the metadata header read.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, FRONTMATTER_LIMIT));
    let read = 0;
    while (read < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(bytes, read, bytes.length - read, null);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const content = bytes.subarray(0, read);
    if (stat.size < FRONTMATTER_LIMIT) {
      if (hash(content) !== manifest.hash) throw stale();
    } else {
      await streamImportFile(join(root, 'SKILL.md'), undefined, manifest.hash, root, signal);
      const after = await handle.stat();
      if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw stale();
    }
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.toString('utf8'));
    if (!match) return null;
    let fields: Record<string, unknown> | null;
    try { fields = parse(match[1]!) as Record<string, unknown> | null; }
    catch { return null; } // YAML exceptions may embed source contents.
    if (typeof fields?.name !== 'string' || typeof fields.description !== 'string') return null;
    // Match Codex's runtime parser, not the stricter skill-authoring validator.
    const name = fields.name.trim().replace(/\s+/gu, ' '), description = fields.description.trim().replace(/\s+/gu, ' ');
    if (!name || Array.from(name).length > 64 || !description) return null;
    return { name, description };
  } finally { await handle.close(); }
}

async function inspect({ home, signal }: Options) {
  signal?.throwIfAborted();
  const root = sourceRoot(home);
  const targetRoot = join(home.configRoot, 'skills');
  const excludedRoots: CodexSkillScan['excludedRoots'] = [
    { path: join(root, '.system'), reason: 'built-in' },
    { path: join(home.userConfigRoot, 'plugins', 'cache'), reason: 'plugin-cache' },
    // A Codex skill folder that links into the shared folder is already read from there.
    { path: join(home.osHomeDir, '.agents', 'skills'), reason: 'shared' },
  ];
  const excluded = await Promise.all(excludedRoots.map(async ({ path }) => disk.realpath(path).catch((error: unknown) => {
    if (missing(error)) return resolve(path);
    throw error;
  })));
  const candidates = new Map<string, Candidate>();
  const bySource = new Map<string, CodexSkillItem>();
  const counts = { codex: 0, duplicates: 0, custom: 0 };
  for (const folder of await names(root)) {
    signal?.throwIfAborted();
    if (folder.startsWith('.')) continue;
    const path = join(root, folder);
    const stat = await disk.lstat(path).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) continue;
    counts.codex++;
    let canonical = path;
    const item: CodexSkillItem = {
      localSourceId: '', kind: 'skill', scope: 'global', name: folder, description: '', aliases: [path],
      fingerprint: null, target: join(targetRoot, folder), status: 'ready',
      resources: { files: 0, hasScripts: false, externalLinks: 0 },
    };
    try {
      const link = stat.isSymbolicLink() ? await resolveAgentHomeImportLink(home, path, home.userConfigRoot) : null;
      canonical = await disk.realpath(path);
      item.localSourceId = 'codex-skill:' + hash(canonical);
      const duplicate = bySource.get(item.localSourceId);
      if (duplicate) { duplicate.aliases.push(path); counts.duplicates++; continue; }
      if ([...excluded, ...excludedRoots.map(({ path }) => resolve(path))]
        .some((excludedRoot) => inside(excludedRoot, canonical) || (link && inside(excludedRoot, link.target)))) {
        item.status = 'skipped'; item.reason = 'excluded';
      } else {
        const snapshot = await snapshotAgentHomeDirectory(home, canonical, { signal });
        const issue = issueReason(snapshot);
        const fields = issue ? null : await metadata(canonical, snapshot, signal);
        if (!fields) { item.status = 'skipped'; item.reason = issue ?? 'invalid-skill'; }
        else {
          Object.assign(item, fields);
          item.fingerprint = fingerprint(snapshot);
          item.resources = {
            files: snapshot.files.filter(({ linkTarget }) => linkTarget === undefined).length,
            hasScripts: [...snapshot.directories, ...snapshot.files].some(({ path }) => path === 'scripts' || path.startsWith('scripts/')),
            externalLinks: snapshot.files.filter(({ linkTarget }) => linkTarget !== undefined && isAbsolute(linkTarget)).length,
          };
          candidates.set(item.localSourceId, { item, source: canonical });
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      item.status = 'skipped';
      const code = (error as NodeJS.ErrnoException).code;
      item.reason = code === 'ELOOP' ? 'cyclic-link' : code === 'ESTALE' ? 'source-changed'
        : error instanceof AgentHomeSensitiveLinkError ? 'sensitive-link' : 'unreadable';
    }
    item.localSourceId ||= 'codex-skill:' + hash(canonical);
    bySource.set(item.localSourceId, item);
  }
  // Also check native names in existing managed folders; a different folder cannot hide a name collision.
  const targetNames = new Map<string, string[]>();
  for (const folder of await names(targetRoot)) {
    signal?.throwIfAborted();
    if (folder.startsWith('.')) continue;
    const path = join(targetRoot, folder);
    try {
      const root = await disk.realpath(path);
      const fields = await metadata(root, await snapshotAgentHomeDirectory(home, root, { signal }), signal);
      if (fields) targetNames.set(fields.name, [...(targetNames.get(fields.name) ?? []), path]);
    } catch { signal?.throwIfAborted(); }
  }
  for (const candidate of candidates.values()) {
    signal?.throwIfAborted();
    const { item } = candidate;
    if ([...candidates.values()].some((other) => other !== candidate
      && (other.item.name === item.name || other.item.target === item.target))
      || targetNames.get(item.name)?.some((path) => path !== item.target)) {
      item.status = 'conflict'; item.reason = 'same-name'; continue;
    }
    const present = await disk.lstat(item.target).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (present) {
      try {
        const target = await snapshotAgentHomeDirectory(home, await disk.realpath(item.target), { signal });
        item.status = !target.issues.length && fingerprint(target) === item.fingerprint ? 'exists' : 'conflict';
      } catch { signal?.throwIfAborted(); item.status = 'conflict'; }
      if (item.status === 'conflict') item.reason = 'target-differs';
    }
  }
  counts.custom = candidates.size;
  return { scan: { count: counts.custom, items: [...bySource.values()], counts, excludedRoots } satisfies CodexSkillScan, candidates };
}

export async function scanCodexSkills(options: Options): Promise<CodexSkillScan> {
  return (await inspect(options)).scan;
}

async function removeStaging(path: string): Promise<void> {
  const stat = await disk.lstat(path);
  if (stat.isDirectory()) {
    await disk.chmod(path, 0o700);
    for (const child of await disk.readdir(path)) {
      const next = join(path, child);
      if ((await disk.lstat(next)).isDirectory()) await removeStaging(next);
    }
  }
  await disk.rm(path, { recursive: true, force: true });
}

async function publish(home: ResolvedAgentHome, candidate: Candidate, signal?: AbortSignal): Promise<void> {
  const { item, source } = candidate;
  await initializeManagedAgentHome(home);
  const root = dirname(item.target);
  try { await disk.mkdir(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!(await disk.lstat(root)).isDirectory()) throw new Error('Managed skill root is not a directory');
  // A hidden complete tree plus an exclusive visible link gives atomic publication without overwriting
  // an existing target. This is the native skills directory, with no parallel registry or source marker.
  const temporary = await disk.mkdtemp(join(root, '.gugu-skill-'));
  let published = false;
  try {
    const copied = await snapshotAgentHomeDirectory(home, source, { destination: temporary, signal });
    const verified = await snapshotAgentHomeDirectory(home, temporary, { signal });
    const current = await snapshotAgentHomeDirectory(home, source, { signal });
    if (issueReason(copied) || issueReason(verified) || issueReason(current)
      || [copied, verified, current].some((snapshot) => fingerprint(snapshot) !== item.fingerprint)) throw stale();
    signal?.throwIfAborted();
    await disk.symlink(basename(temporary), item.target, 'dir');
    published = true;
  } finally {
    if (!published) await removeStaging(temporary);
  }
}

/** Caller owns RPC registration and the shared journal. Selection never accepts renderer-provided paths. */
export async function importCodexSkills(
  options: Options & { selection: readonly CodexSkillSelection[] },
): Promise<{ items: CodexSkillItem[] }> {
  const { home, selection, signal } = options;
  const { scan, candidates } = await inspect(options);
  const selected: Candidate[] = [];
  const results: CodexSkillItem[] = [];
  const seen = new Set<string>();
  for (const choice of selection) {
    signal?.throwIfAborted();
    if (seen.has(choice.localSourceId)) continue;
    seen.add(choice.localSourceId);
    const current = scan.items.find(({ localSourceId }) => localSourceId === choice.localSourceId);
    if (!current) {
      results.push({ localSourceId: choice.localSourceId, kind: 'skill', scope: 'global',
        name: '', description: '', aliases: [], fingerprint: null, target: '', status: 'skipped',
        reason: 'unknown-source', resources: { files: 0, hasScripts: false, externalLinks: 0 } });
      continue;
    }
    const item = { ...current };
    results.push(item);
    if (item.fingerprint !== choice.fingerprint) {
      item.status = 'conflict'; item.reason = 'source-changed'; continue;
    }
    if (item.status === 'ready') selected.push({ ...candidates.get(item.localSourceId)!, item });
  }
  if (selected.length) await checkAgentHomeImportSpace([{
    // The complete batch plus managed-home staging and the existing reserve; no history quota.
    home: { ...home, credentialPaths: [], importGroups: [{ id: 'skills',
      paths: selected.map(({ source }) => source), evidence: 'Selected complete custom skill trees.' }] },
    groups: new Set(['skills']),
  }], signal);
  for (const candidate of selected) {
    signal?.throwIfAborted();
    try { await publish(home, candidate, signal); candidate.item.status = 'imported'; }
    catch (error) {
      signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC') throw error;
      candidate.item.status = code === 'EEXIST' || code === 'ESTALE' ? 'conflict' : 'failed';
      candidate.item.reason = code === 'EEXIST' ? 'target-differs' : code === 'ESTALE' ? 'source-changed' : 'write-failed';
    }
  }
  return { items: results };
}
