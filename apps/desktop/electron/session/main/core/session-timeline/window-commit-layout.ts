import { setImmediate } from 'node:timers/promises';
import { mkdir, open, opendir, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { syncWindowDirectory } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { WindowReceiptDatabase } from './window-commit-receipt';

/** Bump when the committed cache layout changes; the same path clears it. */
export const WINDOW_COMMIT_LAYOUT_VERSION = 1;
export const WINDOW_COMMIT_LAYOUT_MARKER = '.layout';
const BATCH = 64;
/** Exactly the artifacts this clears in the committed directory; anything else
 * is left untouched. Whole subtrees: per-scope source catalogs and the
 * pre-pack per-version projection namespaces. Files: frame heads and their
 * temporaries, raw commit sources, packs, and an interrupted marker. */
export const WINDOW_COMMIT_LAYOUT_DIRECTORIES = ['source-versions', 'projection-versions'] as const;
const artifact = /^(?:[a-f0-9]{64}\.frame(?:\.source)?(?:\.[a-f0-9-]{36}\.tmp)?|[a-f0-9]{32}\.pack(?:\.tmp)?|\.layout\.tmp)$/;
const owned = (name: string, directory: boolean) => directory
  ? (WINDOW_COMMIT_LAYOUT_DIRECTORIES as readonly string[]).includes(name) : artifact.test(name);

/** Exactly the cache metadata tables this clears, children first. Canonical
 * history (`session_turns`, `sessions`, ...) is never touched. */
export const WINDOW_COMMIT_LAYOUT_TABLES = [
  'session_window_pack_dependencies', 'session_window_pack_positions', 'session_window_pack_frames',
  'session_window_pack_sources', 'session_window_pack_groups',
  'session_window_commit_positions', 'session_window_commit_receipts',
] as const;

type Proof = { assertHeld(): void };

async function current(directory: string): Promise<boolean> {
  try {
    const saved = JSON.parse(await readFile(join(directory, WINDOW_COMMIT_LAYOUT_MARKER), 'utf8')) as { version?: unknown };
    return saved?.version === WINDOW_COMMIT_LAYOUT_VERSION;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

/** Remove at most BATCH entries below `path`, depth first. At the root only
 * owned artifacts are removed. Returns true once none remain. */
async function clearBatch(path: string, root: boolean, proof: Proof, left: { count: number }): Promise<boolean> {
  let dir;
  try { dir = await opendir(path, { bufferSize: 1 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
  let empty = true;
  try {
    for (;;) {
      if (left.count <= 0) return false;
      const entry = await dir.read(); if (!entry) break;
      if (root && !owned(entry.name, entry.isDirectory())) continue;
      const child = join(path, entry.name);
      proof.assertHeld();
      if (entry.isDirectory()) {
        if (!await clearBatch(child, false, proof, left)) { empty = false; return false; }
        proof.assertHeld(); await rmdir(child);
      } else await rm(child, { force: true });
      left.count--;
    }
  } finally { await dir.close(); }
  if (!empty) return false;
  await syncWindowDirectory(path);
  return true;
}

function clearTables(connection: WindowReceiptDatabase, proof: Proof): boolean {
  let cleared = true;
  connection.prepare('BEGIN IMMEDIATE').run();
  try {
    proof.assertHeld();
    for (const table of WINDOW_COMMIT_LAYOUT_TABLES) {
      const removed = connection.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ${BATCH})`).run() as { changes: number };
      if (removed.changes) { cleared = false; break; }
    }
    connection.prepare('COMMIT').run();
  } catch (error) { connection.prepare('ROLLBACK').run(); throw error; }
  return cleared;
}

async function writeMarker(directory: string, proof: Proof) {
  const path = join(directory, WINDOW_COMMIT_LAYOUT_MARKER), temporary = `${path}.tmp`;
  proof.assertHeld();
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify({ version: WINDOW_COMMIT_LAYOUT_VERSION })); await file.sync(); }
  finally { await file.close(); }
  proof.assertHeld(); await rename(temporary, path); await syncWindowDirectory(directory);
}

/** Run under the projection gateway before any committed-event writer or
 * projection opens. A missing or older marker means the cache was written by an
 * earlier development layout: clear it in bounded batches, marker last. A crash
 * leaves no marker, so the next start resumes clearing. */
export async function prepareWindowCommitLayout(input: {
  directory: string; connection: WindowReceiptDatabase; proof: Proof; observed?(phase: 'files' | 'tables'): void;
}): Promise<'current' | 'cleared'> {
  const { directory, connection, proof } = input;
  proof.assertHeld();
  await mkdir(directory, { recursive: true });
  if (await current(directory)) return 'current';
  for (;;) {
    const left = { count: BATCH };
    if (await clearBatch(directory, true, proof, left)) break;
    input.observed?.('files'); await setImmediate();
  }
  while (!clearTables(connection, proof)) { input.observed?.('tables'); await setImmediate(); }
  await writeMarker(directory, proof);
  return 'cleared';
}
