import type Database from 'better-sqlite3';
import type { SearchBackfillProgress, TaskTurnIndexStatus } from '@shared/core/search';

let current: SearchBackfillProgress | undefined;
export function setSearchBackfillProgress(progress: SearchBackfillProgress): void { current = progress; }
export function parseSearchBackfillProgress(value: unknown): SearchBackfillProgress | null {
  const p = value as SearchBackfillProgress | null;
  return p && ['running', 'complete', 'failed'].includes(p.state) && Number.isSafeInteger(p.done) && Number.isSafeInteger(p.total)
    && p.done >= 0 && p.total >= p.done ? { state: p.state, done: p.done, total: p.total } : null;
}
/** Ready once every session is in the session index (core/session-index). */
export function taskTurnIndexStatus(connection: Database.Database): TaskTurnIndexStatus {
  const pending = connection.prepare("SELECT EXISTS (SELECT 1 FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM kv WHERE kv.key = 'session-index:' || s.id)) AS n").get() as { n: number };
  if (!pending.n) return { state: 'ready' };
  return { state: current?.state === 'failed' ? 'failed' : 'preparing', ...(current ? { done: current.done, total: current.total } : {}) };
}
