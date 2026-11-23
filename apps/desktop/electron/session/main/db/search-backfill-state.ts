import type { SearchBackfillProgress, TaskTurnIndexStatus } from '@shared/core/search';

let current: SearchBackfillProgress | undefined;
export function setSearchBackfillProgress(progress: SearchBackfillProgress): void { current = progress; }
/** Progress is reported by the eligible startup queue, excluding archived and deferred records. */
export function taskTurnIndexStatus(): TaskTurnIndexStatus {
  if (current?.state === 'complete') return { state: 'ready' };
  return { state: current?.state === 'failed' ? 'failed' : 'preparing', ...(current ? { done: current.done, total: current.total } : {}) };
}
