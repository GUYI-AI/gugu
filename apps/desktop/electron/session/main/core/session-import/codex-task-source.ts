import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import Database from 'better-sqlite3';
import type { CodexTaskHistoryFile, CodexTaskScan, CodexTaskSourceRow } from '@shared/core/session-import/codex-tasks';

type IndexedTask = { id: string; title: string; cwd: string; rollout_path: string; updated_at: number };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** A database path is not authority to read outside the source's live sessions tree. */
async function transcript(root: string, path: string, allowArchived = false, logicalRoot = root) {
  const allowed = (part: string) => !isAbsolute(part) && ['sessions', ...(allowArchived ? ['archived_sessions'] : [])].includes(part.split(sep)[0]) && !part.split(sep).includes('..');
  const rel = [relative(root, resolve(root, path)), relative(resolve(logicalRoot), resolve(logicalRoot, path))].find(allowed);
  if (!rel) throw new Error('Invalid rollout path');
  if (!rel.endsWith('.jsonl') && !rel.endsWith('.jsonl.zst')) throw new Error('Unsupported rollout format');
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Linked rollout path');
  }
  const before = await lstat(current);
  if (!before.isFile()) throw new Error('Invalid rollout file');
  return { path: current, relativePath: rel.split(sep).join('/'), before };
}

/** Read only the first LF-framed record; never materialize a large conversation in the UI process. */
async function sessionMeta(file: Awaited<ReturnType<typeof transcript>>) {
  const input = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const opened = await input.stat();
  if (opened.ino !== file.before.ino || opened.dev !== file.before.dev) { await input.close(); throw new Error('Rollout changed'); }
  const source = input.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
  const decoder = file.path.endsWith('.zst') ? createZstdDecompress() : undefined;
  const stream = decoder ? source.pipe(decoder) : source;
  if (decoder) source.on('error', error => decoder.destroy(error));
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const end = bytes.indexOf(10);
      const part = end < 0 ? bytes : bytes.subarray(0, end);
      length += part.length;
      if (length > 2 * 1024 * 1024) throw new Error('Rollout header is too large');
      chunks.push(part);
      if (end >= 0) break;
    }
    const entry = JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as {
      type?: unknown; payload?: { id?: unknown; cwd?: unknown; source?: unknown; parent_thread_id?: unknown; history_mode?: unknown; history_base?: unknown };
    };
    if (entry.type !== 'session_meta' || typeof entry.payload?.id !== 'string' || !uuid.test(entry.payload.id) || typeof entry.payload.cwd !== 'string'
      || !entry.payload.cwd.trim() || entry.payload.parent_thread_id) throw new Error('Invalid session metadata');
    const base = entry.payload.history_base as CodexTaskHistoryFile['historyBase'];
    if (base && (!uuid.test(base.thread_id) || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 0
      || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 0 || entry.payload.history_mode !== 'paginated')) throw new Error('Invalid history lineage');
    return { id: entry.payload.id, cwd: entry.payload.cwd, historyBase: base ?? null, historyMode: entry.payload.history_mode };
  } finally {
    source.destroy(); decoder?.destroy();
    await input.close();
  }
}

/** Native history_base addresses immutable rollout IDs, which can differ from stable session IDs. */
export async function indexCodexRollouts(root: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const visit = async (path: string): Promise<void> => {
    let stat;
    try { stat = await lstat(join(root, path)); } catch (error) { if (missing(error)) return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) return;
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const id = entry.name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i)?.[1]?.toLowerCase();
        if (id) index.set(id, [...(index.get(id) ?? []), child]);
      }
    }
  };
  await visit('sessions'); await visit('archived_sessions');
  return index;
}

/** Child-only, read-only SQLite metadata scan. No source backfill or private-table mutation. */
export async function scanCodexTasks(sourceRoot: string): Promise<CodexTaskScan> {
  const result: CodexTaskScan = { status: 'ready', indexed: 0, missing: 0, invalid: 0, blocked: [], rows: [] };
  let root: string;
  try { root = await realpath(sourceRoot); }
  catch (error) { if (missing(error)) return { ...result, status: 'unavailable', reason: 'missing-index' }; throw error; }
  let database: Database.Database | undefined;
  let rows: IndexedTask[];
  try {
    const path = join(root, 'state_5.sqlite');
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Linked source index');
    database = new Database(path, { readonly: true, fileMustExist: true });
    database.pragma('query_only = ON');
    rows = database.prepare("SELECT id, title, cwd, rollout_path, updated_at FROM threads WHERE thread_source = 'user' AND archived = 0 ORDER BY updated_at DESC, id").all() as IndexedTask[];
  } catch (error) {
    return { ...result, status: 'unavailable', reason: missing(error) ? 'missing-index' : 'unsupported-index' };
  } finally { database?.close(); }
  result.indexed = rows.length;
  let index: Promise<Map<string, string[]>> | undefined;
  const snapshots = new Map<string, Promise<{ file: Awaited<ReturnType<typeof transcript>>; meta: Awaited<ReturnType<typeof sessionMeta>> }>>();
  const snapshot = (path: string) => {
    let result = snapshots.get(path);
    if (!result) { result = (async () => { const file = await transcript(root, path, true); return { file, meta: await sessionMeta(file) }; })(); snapshots.set(path, result); }
    return result;
  };
  for (const row of rows) {
    if (!uuid.test(row.id) || typeof row.rollout_path !== 'string') { result.invalid++; result.blocked.push({ id: String(row.id), reason: 'invalid-history' }); continue; }
    try {
      let file;
      try { file = await transcript(root, row.rollout_path, false, sourceRoot); }
      catch (error) {
        if (!missing(error) || row.rollout_path.endsWith('.zst')) throw error;
        file = await transcript(root, `${row.rollout_path}.zst`, false, sourceRoot);
      }
      const meta = await sessionMeta(file);
      if (meta.id !== row.id || meta.cwd !== row.cwd) throw new Error('Index and rollout disagree');
      const files: CodexTaskHistoryFile[] = [];
      const revisions: unknown[] = [];
      const seen = new Set<string>();
      let current = { file, meta };
      for (;;) {
        if (seen.has(current.file.relativePath)) throw new Error('Cyclic history lineage');
        seen.add(current.file.relativePath);
        files.push({ relativePath: current.file.relativePath, nativeId: current.meta.id, cwd: current.meta.cwd,
          sizeBytes: current.file.before.size, historyBase: current.meta.historyBase });
        revisions.push([current.file.relativePath, current.file.before.size, current.file.before.mtimeMs, current.file.before.ino, current.meta]);
        const base = current.meta.historyBase;
        if (!base) break;
        const candidates = (await (index ??= indexCodexRollouts(root))).get(base.thread_id.toLowerCase()) ?? [];
        const plain = candidates.filter(path => path.endsWith('.jsonl'));
        const available = plain.length ? plain : candidates;
        if (available.length !== 1) throw Object.assign(new Error('Missing or ambiguous ancestor rollout'), { code: 'HISTORY_DEPENDENCY' });
        try { current = await snapshot(available[0]); }
        catch (error) {
          if (missing(error)) throw Object.assign(new Error('Missing ancestor rollout'), { code: 'HISTORY_DEPENDENCY' });
          throw error;
        }
        if (current.meta.historyMode !== 'paginated') throw new Error('Invalid ancestor history mode');
        if (current.file.path.endsWith('.jsonl') && current.file.before.size < base.end_byte_offset) throw new Error('Truncated ancestor history');
      }
      const metadata = { id: row.id, title: String(row.title ?? '').slice(0, 1000), cwd: meta.cwd,
        relativePath: file.relativePath, updatedAt: Number(row.updated_at) * 1000, sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), files };
      const revision = createHash('sha256').update(JSON.stringify([metadata, revisions])).digest('hex');
      result.rows.push({ ...metadata, revision } satisfies CodexTaskSourceRow);
    } catch (error) {
      if (missing(error)) { result.missing++; result.blocked.push({ id: row.id, reason: 'missing-original' }); }
      else { result.invalid++; result.blocked.push({ id: row.id, reason: (error as NodeJS.ErrnoException).code === 'HISTORY_DEPENDENCY' ? 'missing-history' : 'invalid-history' }); }
    }
  }
  return result;
}

/** A staged or preserved managed file must still belong to the selected native session. */
export async function verifyCodexTaskFiles(root: string, rows: CodexTaskSourceRow[]): Promise<void> {
  const canonical = await realpath(root);
  for (const row of rows) {
    const primary = row.files.find(file => file.relativePath === row.relativePath);
    if (!primary || primary.nativeId !== row.id || primary.cwd !== row.cwd) throw new Error('Copied rollout metadata does not match');
    for (const expected of row.files) {
      const meta = await sessionMeta(await transcript(canonical, expected.relativePath, true));
      if (meta.id !== expected.nativeId || meta.cwd !== expected.cwd || JSON.stringify(meta.historyBase) !== JSON.stringify(expected.historyBase)) throw new Error('Copied rollout metadata does not match');
    }
  }
}
