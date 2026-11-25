import type Database from 'better-sqlite3';
import { setImmediate } from 'node:timers/promises';
import { databaseSpace, type DatabaseSpace } from './space';

export const RECLAIM_MIN_BYTES = 64 * 1024 * 1024;
export const RECLAIM_PAGE_LIMIT = 128;
export const RECLAIM_PASS_MS = 10;

export type ReclaimResult = {
  before: DatabaseSpace; after: DatabaseSpace; reclaimedPages: number;
  state: 'reclaimed' | 'below-threshold' | 'legacy' | 'busy' | 'cancelled';
};

/** One idle slice. One page per SQL statement, yielding before every next page.
 * Nothing converts old NONE databases or waits for another writer. */
export async function reclaimDatabase(
  connection: Database.Database,
  cancelled: () => boolean,
  options: { minimumBytes?: number; pageLimit?: number; now?: () => number; yield?: () => Promise<unknown> } = {},
): Promise<ReclaimResult> {
  const before = databaseSpace(connection);
  let state: ReclaimResult['state'] = 'below-threshold';
  let reclaimedPages = 0;
  const finish = (): ReclaimResult => ({ before, after: databaseSpace(connection), reclaimedPages, state });
  if (cancelled()) { state = 'cancelled'; return finish(); }
  if (connection.pragma('auto_vacuum', { simple: true }) !== 2) { state = 'legacy'; return finish(); }
  const minimum = options.minimumBytes ?? RECLAIM_MIN_BYTES;
  if (before.freelistCount * before.pageSize < minimum || before.freelistCount < before.pageCount * 0.2) return finish();
  const now = options.now ?? (() => performance.now());
  const started = now();
  const pageLimit = Math.min(RECLAIM_PAGE_LIMIT, options.pageLimit ?? RECLAIM_PAGE_LIMIT);
  const yieldNext = options.yield ?? setImmediate;
  // This connection is owned by the maintenance worker, never an app writer.
  connection.pragma('busy_timeout = 0');
  try {
    while (reclaimedPages < pageLimit && now() - started < RECLAIM_PASS_MS) {
      if (cancelled()) { state = 'cancelled'; break; }
      if (connection.pragma('freelist_count', { simple: true }) === 0) break;
      // Drain every result: simple:true/get() can stop a row-producing pragma early.
      connection.pragma('incremental_vacuum(1)');
      reclaimedPages += 1;
      state = 'reclaimed';
      await yieldNext();
    }
  } catch (error) {
    if ((error as { code?: string }).code !== 'SQLITE_BUSY' && (error as { code?: string }).code !== 'SQLITE_LOCKED') throw error;
    state = 'busy';
  }
  return finish();
}
