import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import { canonicalPath, type CanonicalPath } from '@gugu/session-core/files';
import { db } from '@main/db/client';
import { projects, workspaces } from '@main/db/schema';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import type { OpenedOutput } from '@gugu/session-core/acp/client';

/**
 * @@@canonical-path migration: records written before a folder had one spelling — a server's task folder recorded through
 * the account link `accounts/<id>` (left by the 11-03 move to `account`), a project typed with a trailing slash — are
 * rewritten once into it, so nothing past them ever compares two spellings of one folder. The link itself stays on disk:
 * paths outside these records (an old chat's file link, a tool's history) still open through it.
 *
 * Recorded before it is changed (`file`): what each row was, for a rollback. Idempotent: a row already canonical is left.
 * A row whose canonical spelling another row already holds is left as it is and said (`conflicts`): two records of one
 * folder are a merge, never decided here.
 */
export type CanonicalPathMigrationRecord = {
  version: 1;
  moved: { table: 'projects' | 'workspaces'; id: string; from: string; to: string; at: string }[];
};

function readRecord(file: string): CanonicalPathMigrationRecord {
  if (!existsSync(file)) return { version: 1, moved: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as CanonicalPathMigrationRecord;
  if (parsed?.version !== 1 || !Array.isArray(parsed.moved)) throw new Error(`${file}: not a canonical-path migration record`);
  return parsed;
}

function writeRecord(file: string, record: CanonicalPathMigrationRecord): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
}

const canonicalOrNull = (value: string): CanonicalPath | null => {
  try { return canonicalPath(value); } catch { return null; }
};

export type CanonicalPathMigration = {
  moved: CanonicalPathMigrationRecord['moved'];
  conflicts: { table: 'projects' | 'workspaces'; id: string; path: string }[];
};

/** The rows: projects and workspaces of this machine. */
export function migrateCanonicalPaths(file: string): CanonicalPathMigration {
  const at = new Date().toISOString();
  const conflicts: CanonicalPathMigration['conflicts'] = [];
  const projectMoves = db.select({ id: projects.id, path: projects.path }).from(projects)
    .where(eq(projects.workspaceProvider, 'local')).all()
    .flatMap((row) => {
      const to = canonicalOrNull(row.path);
      return to && to !== row.path ? [{ table: 'projects' as const, id: row.id, from: row.path as string, to, at }] : [];
    });
  const workspaceMoves = db.select({ id: workspaces.id, path: workspaces.path, location: workspaces.location }).from(workspaces).all()
    .flatMap((row) => {
      if (!row.path || row.location === 'remote') return [];
      const to = canonicalOrNull(row.path);
      return to && to !== row.path ? [{ table: 'workspaces' as const, id: row.id, from: row.path as string, to, at }] : [];
    });
  const moves = [...projectMoves, ...workspaceMoves];
  if (moves.length === 0) return { moved: [], conflicts };
  // 先记、后改:记录写不下去就不改,回滚永远知道改过哪些行。
  const record = readRecord(file);
  record.moved.push(...moves);
  writeRecord(file, record);
  const moved: CanonicalPathMigrationRecord['moved'] = [];
  db.transaction((tx) => {
    for (const move of moves) {
      if (move.table === 'projects') {
        const taken = tx.select({ id: projects.id }).from(projects).where(and(eq(projects.path, move.to), ne(projects.id, move.id))).get();
        if (taken) { conflicts.push({ table: 'projects', id: move.id, path: move.from }); continue; }
        tx.update(projects).set({ path: move.to }).where(eq(projects.id, move.id)).run();
      } else {
        const key = computeWorkspaceKey(move.to);
        const taken = tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.key, key), ne(workspaces.id, move.id))).get();
        if (taken) { conflicts.push({ table: 'workspaces', id: move.id, path: move.from }); continue; }
        tx.update(workspaces).set({ path: move.to, key }).where(eq(workspaces.id, move.id)).run();
      }
      moved.push(move);
    }
  });
  // Said at every start while it stands (the run is idempotent, so a conflict comes back each time), at warn: it is the
  // one outcome a person has to act on.
  if (conflicts.length > 0) {
    log.warn('canonical paths: rows left as they were, another row holds their folder', { count: conflicts.length, first: conflicts[0]!.path, conflicts });
  }
  return { moved, conflicts };
}

/** What each session has opened (`session-outputs`), in the folders' new spelling: its cards and reads match the files'. */
export async function migrateSessionOutputPaths(moved: readonly { from: string; to: string }[]): Promise<number> {
  if (moved.length === 0) return 0;
  const store = new KV<Record<string, OpenedOutput[]>>('session-outputs');
  const rewrite = (value: string) => {
    for (const { from, to } of moved) {
      if (value === from) return to;
      if (value.startsWith(from + path.sep)) return to + value.slice(from.length);
    }
    return value;
  };
  let changed = 0;
  for (const [sessionId, outputs] of Object.entries(await store.getAll())) {
    if (!Array.isArray(outputs)) continue;
    let touched = false;
    const next = outputs.map((output) => {
      if (output.kind !== 'file') return output;
      const to = rewrite(output.path);
      if (to === output.path) return output;
      touched = true;
      return { ...output, path: to };
    });
    if (touched) { await store.setOrThrow(sessionId, next); changed += 1; }
  }
  return changed;
}

/** Claude keeps a folder's sessions under `projects/<the folder, every other character as ->`: `--resume` looks there. */
export const claudeProjectKey = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, '-');

async function countEntries(dir: string): Promise<number> {
  return (await readdir(dir).catch(() => [])).length;
}

async function copyMissing(from: string, to: string): Promise<number> {
  let copied = 0;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copied += await copyMissing(source, target);
    else if (entry.isFile() && !(await stat(target).catch(() => null))) {
      await copyFile(source, target);
      copied += 1;
    }
  }
  return copied;
}

/**
 * A folder's Claude history, under its new spelling too: a session started in it before can still be resumed there. Copied,
 * never moved, never over a file already there (as `claude-history-move.ts`). Says each root's folder count before and after.
 */
export async function copyClaudeHistoryForMovedFolders(roots: readonly string[], moved: readonly { from: string; to: string }[]): Promise<{ root: string; before: number; after: number; copied: number }[]> {
  const report: { root: string; before: number; after: number; copied: number }[] = [];
  for (const root of new Set(roots)) {
    const projectsDir = path.join(root, 'projects');
    if (!(await stat(projectsDir).catch(() => null))?.isDirectory()) continue;
    const before = await countEntries(projectsDir);
    let copied = 0;
    for (const { from, to } of moved) {
      const source = path.join(projectsDir, claudeProjectKey(from));
      if (!(await stat(source).catch(() => null))?.isDirectory()) continue;
      copied += await copyMissing(source, path.join(projectsDir, claudeProjectKey(to)));
    }
    report.push({ root, before, after: await countEntries(projectsDir), copied });
  }
  return report;
}
