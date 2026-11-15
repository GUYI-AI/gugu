import { Worker } from 'node:worker_threads';
import { resolveDatabasePath } from '@main/db/path';
import { desktopWorkerPath } from '@main/worker-manifest';
import type { TaskTurnMatch } from './task-turn-matches';

type Answer = { id: number; matches: TaskTurnMatch[] } | { id: number; error: string };
type Live = { worker: Worker; asked: Map<number, { resolve: (matches: TaskTurnMatch[]) => void; reject: (error: Error) => void }> };
let live: Live | null = null;
let lastId = 0;

function start(): Live {
  const worker = new Worker(desktopWorkerPath('task-turn-search'), { workerData: { database: resolveDatabasePath() }, name: 'task-turn-search' });
  const own: Live = { worker, asked: new Map() };
  // A thread that dies answers nobody: everything asked of it fails, and the next search starts another.
  const fail = (error: Error) => {
    if (live === own) live = null;
    for (const { reject } of own.asked.values()) reject(error);
    own.asked.clear();
  };
  worker.on('message', (answer: Answer) => {
    const asker = own.asked.get(answer.id);
    if (!asker) return;
    own.asked.delete(answer.id);
    if ('error' in answer) asker.reject(new Error(answer.error)); else asker.resolve(answer.matches);
  });
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`Task search thread exited (${code})`)));
  worker.unref();
  return own;
}

/** Task-turn matches, found on the search thread (started by the first search): the query never holds the main thread. */
export function searchTaskTurnMatches(query: string, limit?: number): Promise<TaskTurnMatch[]> {
  const own = live ??= start();
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    own.asked.set(id, { resolve, reject });
    own.worker.postMessage({ id, query, limit });
  });
}

export function stopTaskTurnSearch(): void {
  const own = live; live = null;
  if (own) void own.worker.terminate();
}
