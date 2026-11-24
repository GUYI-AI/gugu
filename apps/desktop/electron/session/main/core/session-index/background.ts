import { setImmediate } from 'node:timers/promises';
import { sqlite } from '@main/db/client';
import { setSearchBackfillProgress } from '@main/db/search-backfill-state';
import { backfillSessionIndex } from '../session-timeline/service';
import { sessionEvents } from '../sessions/session-events';
import { prepareSessionIndex, removeSessionFromIndex, sessionIndexDue, sessionIndexed } from './session-index';

export type SessionIndexLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

let controller: AbortController | undefined;
let unsubscribe: (() => void) | undefined;

export async function indexSessionsInBackground(log: SessionIndexLogger): Promise<void> {
  if (controller) return;
  const own = controller = new AbortController();
  const started = Date.now();
  try {
    await prepareSessionIndex();
  } catch (error) {
    if (own.signal.aborted) return;
    setSearchBackfillProgress({ state: 'failed', done: 0, total: 0 });
    controller = undefined;
    throw error;
  }
  if (own.signal.aborted) return;
  const ids = (sqlite.prepare(`SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id
    WHERE s.archived_at IS NULL AND p.workspace_provider = 'local' ORDER BY s.updated_at DESC`).all() as { id: string }[])
    .map(row => row.id).filter(id => sessionIndexDue(id, started));

  const process = async (id: string, respectRetry: boolean) => {
    try { return await backfillSessionIndex(id, respectRetry); }
    catch (error) {
      if (!own.signal.aborted) log.error({ sessionId: id, error: String(error) }, 'Session index read failed');
      return 'failed';
    }
  };
  // Restoration uses the same event as creation. A row already indexed does not need another full read.
  const stopCreated = sessionEvents.on('session:created', session => {
    if (!sessionIndexed(session.id)) void process(session.id, false);
  });
  const stopDeleted = sessionEvents.on('session:deleted', async id => { await removeSessionFromIndex(id); });
  unsubscribe = () => { stopCreated(); stopDeleted(); };
  setSearchBackfillProgress({ state: 'running', done: 0, total: ids.length });
  let failed = 0, missing = 0, done = 0;
  for (const id of ids) {
    if (own.signal.aborted) return;
    const result = await process(id, true);
    if (result === 'missing') missing++;
    if (result === 'failed') failed++;
    setSearchBackfillProgress({ state: 'running', done: ++done, total: ids.length });
    await setImmediate();
  }
  if (own.signal.aborted) return;
  setSearchBackfillProgress({ state: failed ? 'failed' : 'complete', done, total: ids.length });
  log.info({ done, total: ids.length, failed, missing, elapsedMs: Date.now() - started }, 'Session index built');
}

export function stopSessionIndexBackfill(): void {
  controller?.abort();
  controller = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
}
