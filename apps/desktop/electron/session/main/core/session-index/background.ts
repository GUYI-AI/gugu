import { setImmediate } from 'node:timers/promises';
import type { SearchBackfillProgress } from '@shared/core/search';
import { sqlite } from '@main/db/client';
import { setSearchBackfillProgress } from '@main/db/search-backfill-state';
import { ensureSessionIndexed } from '../session-timeline/service';

export type SessionIndexLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

let running = false;

/**
 * After the host is ready: every session nobody has had open since the index was built is read once, one at a time,
 * newest first (the ones a person is likeliest to search). A session that cannot be read is logged and left for the
 * next start; the rest go on.
 */
export async function indexSessionsInBackground(log: SessionIndexLogger): Promise<void> {
  if (running) return;
  running = true;
  const started = Date.now();
  const ids = (sqlite.prepare(`SELECT s.id FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM kv WHERE kv.key = 'session-index:' || s.id)
    ORDER BY s.updated_at DESC`).all() as { id: string }[]).map((row) => row.id);
  let progress: SearchBackfillProgress = { state: 'running', done: 0, total: ids.length };
  setSearchBackfillProgress(progress);
  let failed = 0;
  try {
    for (const id of ids) {
      try { await ensureSessionIndexed(id); }
      catch (error) {
        failed += 1;
        log.error({ sessionId: id, error: String(error) }, 'Session index: a session could not be read; next start tries again');
      }
      progress = { ...progress, done: progress.done + 1 };
      setSearchBackfillProgress(progress);
      await setImmediate();
    }
    progress = { ...progress, state: failed ? 'failed' : 'complete' };
    setSearchBackfillProgress(progress);
    log.info({ ...progress, failed, elapsedMs: Date.now() - started }, 'Session index built');
  } finally {
    running = false;
  }
}
