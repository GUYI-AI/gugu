import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import Database from 'better-sqlite3';
import type { CodexTaskScan, CodexTaskSourceRow } from '@shared/core/session-import/codex-tasks';

type IndexedTask = { id: string; title: string; cwd: string; rollout_path: string; updated_at: number };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** A database path is not authority to read outside the source's live sessions tree. */
async function transcript(root: string, path: string) {
  const rel = relative(root, resolve(root, path));
  if (isAbsolute(rel) || rel.split(sep)[0] !== 'sessions' || rel.split(sep).includes('..')) throw new Error('Invalid rollout path');
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
      type?: unknown; payload?: { id?: unknown; cwd?: unknown; source?: unknown; parent_thread_id?: unknown };
    };
    if (entry.type !== 'session_meta' || typeof entry.payload?.id !== 'string' || typeof entry.payload.cwd !== 'string'
      || !entry.payload.cwd.trim() || entry.payload.parent_thread_id) throw new Error('Invalid session metadata');
    return { id: entry.payload.id, cwd: entry.payload.cwd };
  } finally {
    source.destroy(); decoder?.destroy();
    await input.close();
  }
}

/** Child-only, read-only SQLite metadata scan. No source backfill or private-table mutation. */
export async function scanCodexTasks(sourceRoot: string): Promise<CodexTaskScan> {
  const result: CodexTaskScan = { status: 'ready', indexed: 0, missing: 0, invalid: 0, rows: [] };
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
  for (const row of rows) {
    if (!uuid.test(row.id) || typeof row.rollout_path !== 'string') { result.invalid++; continue; }
    try {
      let file;
      try { file = await transcript(root, row.rollout_path); }
      catch (error) {
        if (!missing(error) || row.rollout_path.endsWith('.zst')) throw error;
        file = await transcript(root, `${row.rollout_path}.zst`);
      }
      const meta = await sessionMeta(file);
      if (meta.id !== row.id || meta.cwd !== row.cwd) throw new Error('Index and rollout disagree');
      const metadata = { id: row.id, title: String(row.title ?? '').slice(0, 1000), cwd: meta.cwd,
        relativePath: file.relativePath, updatedAt: Number(row.updated_at) * 1000, sizeBytes: file.before.size };
      const revision = createHash('sha256').update(JSON.stringify([metadata, file.before.mtimeMs, file.before.ino])).digest('hex');
      result.rows.push({ ...metadata, revision } satisfies CodexTaskSourceRow);
    } catch (error) { if (missing(error)) result.missing++; else result.invalid++; }
  }
  return result;
}

/** A staged or preserved managed file must still belong to the selected native session. */
export async function verifyCodexTaskFiles(root: string, rows: Pick<CodexTaskSourceRow, 'id' | 'cwd' | 'relativePath'>[]): Promise<void> {
  const canonical = await realpath(root);
  for (const row of rows) {
    const meta = await sessionMeta(await transcript(canonical, row.relativePath));
    if (meta.id !== row.id || meta.cwd !== row.cwd) throw new Error('Copied rollout metadata does not match');
  }
}
