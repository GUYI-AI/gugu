import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '@gugu/core/local/childProcess';
import { KeyedMutex } from '@gugu/session-core/lib';

export type CodexProjectSource = {
  projectId: string;
  name: string;
  position: number;
  rootPosition: number;
  revision: string;
};
export type CodexProjectItem = {
  localSourceId: string;
  type: 'project';
  name: string;
  scope: 'project';
  sourceFingerprint: string;
  directory: string;
  sources: CodexProjectSource[];
  status: 'ready' | 'missing-directory' | 'unreadable-directory';
};
export type CodexProjectScan = {
  sourceRoot: string;
  sourceStatus: 'ready' | 'missing';
  sourceProjectCount: number;
  count: number;
  items: CodexProjectItem[];
};
export type CodexProjectOptions = { sourceRoot?: string; signal?: AbortSignal };
export type CodexProjectSelection = { localSourceId: string; sourceFingerprint: string };
export type CodexProjectImportResult = CodexProjectSelection & {
  type: 'project';
  scope: 'project';
  status: 'imported' | 'exists' | 'skipped' | 'conflict' | 'failed';
  reason?: 'source-changed' | 'missing-directory' | 'unreadable-directory' | 'archived-target'
    | 'create-failed' | 'open-failed' | 'target-unavailable';
  target?: { projectId: string; directory: string };
};

type SourceRow = CodexProjectSource & { path: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const claims = new KeyedMutex();

// One read transaction in a disposable child: no native SQLite or source bodies
// run on Electron's main thread. Read-only WAL access includes committed rows.
const READ_PROJECTS = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
let db;
try {
  db = new DatabaseSync(process.argv[1], { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
  const count = db.prepare('SELECT count(*) AS count FROM projects').get().count;
  const rows = db.prepare(
    'SELECT p.id AS projectId, p.name, p.position, p.metadata, p.created_at_ms, p.updated_at_ms, '
    + 'r.position AS rootPosition, r.path FROM projects p JOIN project_roots r ON r.project_id=p.id '
    + 'ORDER BY p.position, p.id, r.position'
  ).all().map(row => {
    const revision = createHash('sha256').update(JSON.stringify(row)).digest('hex');
    return { projectId: row.projectId, name: row.name, position: row.position,
      rootPosition: row.rootPosition, path: row.path, revision };
  });
  db.exec('COMMIT');
  process.stdout.write(JSON.stringify({ count, rows }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: /busy|locked/i.test(String(error.code) + String(error.message))
    ? 'source-busy' : 'source-unreadable' }));
  process.exitCode = 1;
} finally { db?.close(); }
`;

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

async function sourceRoot(options: CodexProjectOptions): Promise<string> {
  const root = resolve(options.sourceRoot ?? join(homedir(), '.codex'));
  try { return await realpath(root); }
  catch (error) { if (code(error) === 'ENOENT') return root; throw error; }
}

async function readRows(root: string, signal?: AbortSignal): Promise<{ count: number; rows: SourceRow[] } | null> {
  signal?.throwIfAborted();
  const file = join(root, 'state_5.sqlite');
  try { await access(file); }
  catch (error) { if (code(error) === 'ENOENT') return null; throw new Error('Codex project source is unreadable'); }
  let stdout: string;
  try {
    ({ stdout } = await execute(process.execPath, ['--no-warnings', '-e', READ_PROJECTS, file], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', signal, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    signal?.throwIfAborted();
    // Child errors include command/env/stderr. Never expose them to a renderer.
    const output = (error as { stdout?: string }).stdout;
    if (output?.includes('"source-busy"')) throw new Error('Codex project source is busy');
    throw new Error('Codex project source could not be read');
  }
  signal?.throwIfAborted();
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object' || !('rows' in parsed) || !('count' in parsed)
    || !Array.isArray(parsed.rows) || typeof parsed.count !== 'number') {
    throw new Error('Invalid Codex project source');
  }
  const rows: SourceRow[] = [];
  for (const row of parsed.rows as SourceRow[]) {
    if (!row || typeof row.path !== 'string' || !isAbsolute(row.path) || row.path.includes('\0')
      || typeof row.projectId !== 'string' || typeof row.name !== 'string'
      || typeof row.revision !== 'string' || !Number.isInteger(row.position) || !Number.isInteger(row.rootPosition)) {
      throw new Error('Invalid Codex project source');
    }
    rows.push(row);
  }
  return { count: parsed.count, rows };
}

async function directoryState(directory: string): Promise<CodexProjectItem['status']> {
  try {
    if (!(await stat(directory)).isDirectory()) return 'missing-directory';
    await access(directory, 4 | 1);
    return 'ready';
  } catch (error) { return code(error) === 'ENOENT' || code(error) === 'ENOTDIR' ? 'missing-directory' : 'unreadable-directory'; }
}

/** Metadata only. config.toml path trust entries are deliberately never read. */
export async function scanCodexProjects(options: CodexProjectOptions = {}): Promise<CodexProjectScan> {
  options.signal?.throwIfAborted();
  const root = await sourceRoot(options);
  const snapshot = await readRows(root, options.signal);
  if (!snapshot) return { sourceRoot: root, sourceStatus: 'missing', sourceProjectCount: 0, count: 0, items: [] };
  const directories = new Map<string, CodexProjectSource[]>();
  for (const { path, ...source } of snapshot.rows) {
    options.signal?.throwIfAborted();
    let directory: string;
    try { directory = await realpath(path); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code(error) ?? '')) throw error;
      directory = resolve(path);
    }
    const entries = directories.get(directory) ?? [];
    entries.push(source);
    directories.set(directory, entries);
  }
  const items: CodexProjectItem[] = [];
  for (const [directory, sources] of directories) {
    options.signal?.throwIfAborted();
    items.push({
      localSourceId: `codex:project:${hash(JSON.stringify([root, directory]))}`,
      type: 'project', scope: 'project', directory, sources,
      name: sources.length === 1 ? sources[0].name : basename(directory) || directory,
      sourceFingerprint: hash(JSON.stringify([directory, sources])),
      status: await directoryState(directory),
    });
  }
  return { sourceRoot: root, sourceStatus: 'ready', sourceProjectCount: snapshot.count, count: items.length, items };
}

/**
 * Re-read selections by opaque source ID. Neither a renderer-supplied directory
 * nor a stale scan can register/open an arbitrary path.
 */
export async function importCodexProjects(
  selection: readonly CodexProjectSelection[],
  options: CodexProjectOptions = {},
): Promise<CodexProjectImportResult[]> {
  options.signal?.throwIfAborted();
  const scan = await scanCodexProjects(options);
  const byId = new Map(scan.items.map(item => [item.localSourceId, item]));
  const results: CodexProjectImportResult[] = [];
  const operations = await Promise.all([
    import('../projects/operations/getProjects'),
    import('../projects/operations/project-folders'),
    import('../projects/operations/create-local-project'),
    import('../projects/operations/openProject'),
  ]);
  const [{ getLocalProjectByPath }, { getProjectOwningAttachedFolder }, { createLocalProject }, { openProject }] = operations;
  for (const selected of selection) {
    options.signal?.throwIfAborted();
    const base = { localSourceId: selected.localSourceId, sourceFingerprint: selected.sourceFingerprint,
      type: 'project' as const, scope: 'project' as const };
    const item = byId.get(selected.localSourceId);
    if (!item || item.sourceFingerprint !== selected.sourceFingerprint) {
      results.push({ ...base, status: 'conflict', reason: 'source-changed' });
      continue;
    }
    let release: (() => void) | undefined;
    try {
      release = await claims.acquire(item.directory, options.signal);
      options.signal?.throwIfAborted();
      const state = await directoryState(item.directory);
      if (state !== 'ready') {
        results.push({ ...base, status: 'skipped', reason: state });
        continue;
      }
      const attached = await getProjectOwningAttachedFolder(item.directory);
      const existing = attached ?? await getLocalProjectByPath(item.directory);
      if (existing?.archivedAt) {
        results.push({ ...base, status: 'skipped', reason: 'archived-target', target: { projectId: existing.id, directory: item.directory } });
        continue;
      }
      options.signal?.throwIfAborted();
      // Match local-session import: only a directory with its own .git marker
      // goes through repository inspection. A subdirectory keeps its exact cwd.
      const isRepositoryRoot = !existing && await access(join(item.directory, '.git')).then(
        () => true,
        (error: unknown) => { if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return false; throw error; },
      );
      options.signal?.throwIfAborted();
      const created = existing ? undefined : await createLocalProject({
        path: item.directory, name: item.name,
        allowNonGit: true, exactPath: !isRepositoryRoot, reuseExisting: true, automatic: true,
        createDirectory: false, initGitRepository: false,
      });
      if (created && !created.success) {
        results.push({ ...base, status: 'failed', reason: 'create-failed' });
        continue;
      }
      const project = existing ?? (created?.success ? created.data : undefined);
      if (!project) throw new Error('Missing imported project');
      const target = { projectId: project.id, directory: item.directory };
      // Also inspect the returned target: an automatic create may race another
      // registration and reuse its archived row. Never open/restore that row.
      if (project.archivedAt) {
        results.push({ ...base, status: 'skipped', reason: 'archived-target', target });
        continue;
      }
      // Once registered, finish the mount and report it even if cancellation
      // arrives. Cancellation is checked before the next item, not after commit.
      const opened = await openProject(project.id);
      results.push({ ...base, target,
        status: opened.success ? existing ? 'exists' : 'imported' : 'failed',
        ...(opened.success ? {} : { reason: 'open-failed' as const }),
      });
    } catch {
      options.signal?.throwIfAborted();
      results.push({ ...base, status: 'failed', reason: 'target-unavailable' });
    } finally { release?.(); }
  }
  return results;
}
