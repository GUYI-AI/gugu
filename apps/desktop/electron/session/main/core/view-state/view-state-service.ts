import { asc, eq, like, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { kv, sessions } from '@main/db/schema';
import { rootFolderOf } from '@main/core/folders/folders';
import { legacyProject } from '@main/core/folders/legacy-project-aliases';
import { log } from '@main/lib/logger';
import { sanitizeNavigationSnapshotForRestore, type RestoredSessionState } from './navigation-restore';

const NAMESPACE = 'view-state:';
const FLUSH_DELAY_MS = 1000;

/**
 * View state (③) is written behind: a save lands in `pending` at once, so every read here already sees it, and reaches
 * the database within FLUSH_DELAY_MS in one transaction (typing a search word is one row write, not one per key). The
 * ways out run `flushViewState` first — the cleanup's database phase, a signal (signal-exit) and a crash (process-exit) —
 * so a word typed just before a quit or a SIGTERM is on disk. A lost installation lock does not: the database is another
 * process's by then. SQL that rewrites view-state rows flushes right before its transaction. `value === null` = delete. `at` orders rows by last write:
 * the renderer evicts the oldest of a model over its cap, and the snapshot hands them over in that order.
 */
const pending = new Map<string, { value: string | null; at: number }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let clock = 0;
const stamp = () => (clock = Math.max(clock + 1, Date.now()));

function stage(key: string, value: string | null): void {
  pending.delete(key);
  pending.set(key, { value, at: stamp() });
  flushTimer ??= setTimeout(() => {
    try {
      flushViewState();
    } catch (error) {
      log.error('view state flush failed; kept for the next try', { error: String(error) });
    }
  }, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

export function flushViewState(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!pending.size) return;
  const writes = [...pending];
  db.transaction((tx) => {
    for (const [key, { value, at }] of writes) {
      if (value === null) tx.delete(kv).where(eq(kv.key, NAMESPACE + key)).run();
      else tx.insert(kv).values({ key: NAMESPACE + key, value, updatedAt: at }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: at } }).run();
    }
  });
  // Only what was written leaves: a save that arrived meanwhile has a newer stamp and stays.
  for (const [key, write] of writes) if (pending.get(key) === write) pending.delete(key);
}

const parse = (key: string, raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    log.error('view state row is malformed; not restored', { key });
    return undefined;
  }
};

/**
 * Every stored entry, oldest write first, for the renderer's first frame (preload asks for it synchronously). Read
 * straight from the database: better-sqlite3 is synchronous. A database that has no kv table yet (the first start,
 * before its migrations) has nothing stored.
 */
export function viewStateSnapshot(): Record<string, unknown> {
  const hasTable = db.all(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'`).length > 0;
  const result: Record<string, unknown> = {};
  if (hasTable) {
    const rows = db.select().from(kv).where(like(kv.key, `${NAMESPACE}%`)).orderBy(asc(kv.updatedAt)).all();
    for (const row of rows) {
      const key = row.key.slice(NAMESPACE.length);
      if (pending.has(key)) continue;
      const value = parse(key, row.value);
      if (value !== undefined) result[key] = value;
    }
  }
  for (const [key, { value }] of pending) if (value !== null) result[key] = parse(key, value);
  return result;
}

/**
 * 这条会话在这台机器眼里是什么状态 —— 「确知已删除」只认一种:它的工作目录在这台机器上,会话行却没了
 * (归档会保留行)。工作目录也不在这台机器上 = 会话在
 * 别的机器上(咕咕 server、别的电脑):这里不知道它的死活,❌ 当成删了 —— 由那台机器说了算。
 * 升级前存下的快照只记着老项目 id:经别名表认出它在这台机器上。
 */
async function restoredSessionState(sessionId: string, place: { workspaceId: string; legacyProjectId: string }): Promise<RestoredSessionState> {
  const [row] = await db
    .select({ archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (row) return row.archivedAt ? 'archived' : 'live';
  if (!place.workspaceId && !place.legacyProjectId) return 'deleted';
  const here = place.workspaceId ? rootFolderOf(place.workspaceId) !== undefined : legacyProject(place.legacyProjectId) !== undefined;
  return here ? 'deleted' : 'elsewhere';
}

function read(key: string): unknown {
  const staged = pending.get(key);
  if (staged) return staged.value === null ? null : parse(key, staged.value);
  const [row] = db.select({ value: kv.value }).from(kv).where(eq(kv.key, NAMESPACE + key)).limit(1).all();
  return row ? parse(key, row.value) ?? null : null;
}

export const viewStateService = {
  save: async (key: string, snapshot: unknown): Promise<void> => stage(key, JSON.stringify(snapshot)),

  get: async (key: string): Promise<unknown> => {
    const snapshot = read(key);
    if (key !== 'navigation') return snapshot;
    // #4277 开机不能默认落到已归档 / 已删除的会话上(见 navigation-restore.ts)。DB 查询一次,同步判。
    const session = (snapshot as { viewParams?: { session?: { sessionId?: unknown; workspaceId?: unknown; projectId?: unknown } } } | null)
      ?.viewParams?.session;
    const sessionId = session?.sessionId;
    const place = {
      workspaceId: typeof session?.workspaceId === 'string' ? session.workspaceId : '',
      legacyProjectId: typeof session?.projectId === 'string' ? session.projectId : '',
    };
    const state = typeof sessionId === 'string' && sessionId ? await restoredSessionState(sessionId, place) : 'live';
    return sanitizeNavigationSnapshotForRestore(snapshot, () => state);
  },

  getAll: async (): Promise<Record<string, unknown>> => viewStateSnapshot(),

  del: async (key: string): Promise<void> => stage(key, null),

  reset: async (): Promise<void> => {
    pending.clear();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    db.delete(kv).where(like(kv.key, `${NAMESPACE}%`)).run();
  },
};
