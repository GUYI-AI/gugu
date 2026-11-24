import Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { SessionTimeline } from '@gugu/session-core/session-record';
import { sqlite } from '@main/db/client';
import { resolveDatabasePath } from '@main/db/path';
import { desktopWorkerPath } from '@main/worker-manifest';
import { log } from '@main/lib/logger';
import { readIndexState, sessionIndexPath, type TurnRow } from './store';
import type { IndexCommand, IndexReply, IndexSource } from './worker';

type IndexResult = Extract<IndexReply, { result: string }>['result'];
type Waiter = { resolve: (result: IndexResult) => void; reject: (error: Error) => void };
let worker: Worker | undefined;
let reader: Database.Database | undefined;
let indexReady = false;
let nextId = 0;
const waiters = new Map<number, Waiter>();
const followers = new Set<() => void>();

function startWorker(): Worker {
  const own = new Worker(desktopWorkerPath('session-index'), { workerData: { database: resolveDatabasePath() }, name: 'session-index' });
  const fail = (error: Error) => {
    if (worker !== own) return;
    worker = undefined;
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  };
  own.on('message', (reply: IndexReply) => {
    const waiter = waiters.get(reply.id);
    if (!waiter) return;
    waiters.delete(reply.id);
    if ('error' in reply) waiter.reject(Object.assign(new Error(reply.error), { name: reply.name }));
    else {
      indexReady = true;
      waiter.resolve(reply.result);
    }
  });
  own.on('error', fail);
  own.on('exit', code => fail(new Error(`Session index worker exited (${code})`)));
  own.unref();
  return own;
}

async function run(command: IndexCommand): Promise<IndexResult> {
  const own = worker ??= startWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    try { own.postMessage({ id, command }); }
    catch (error) { waiters.delete(id); reject(error); }
  });
}

function readIndex(): Database.Database | undefined {
  if (!indexReady) return;
  return reader ??= new Database(sessionIndexPath(sqlite.name), { readonly: true, timeout: 0 });
}

export function removeSessionFromIndex(sessionId: string) { return run({ kind: 'delete', sessionId }); }

export async function prepareSessionIndex(): Promise<void> {
  if (!indexReady) await run({ kind: 'ready' });
}

export async function stopSessionIndex(): Promise<void> {
  for (const stop of followers) stop();
  const own = worker;
  try {
    // The worker replies in order. Flush timeline changes before closing its database.
    if (own && waiters.size) await run({ kind: 'ready' });
  } finally {
    if (worker === own) worker = undefined;
    if (own) await own.terminate();
    reader?.close();
    reader = undefined;
    indexReady = false;
  }
}

export function sessionIndexed(sessionId: string): boolean {
  const index = readIndex();
  if (!index) return sqlite.prepare('SELECT 1 FROM kv WHERE key = ?').get(`session-index:${sessionId}`) !== undefined;
  const state = readIndexState(index, sessionId);
  return state !== undefined && state.retry_at === null;
}

export function sessionIndexDue(sessionId: string, now: number): boolean {
  const index = readIndex();
  if (!index) return !sessionIndexed(sessionId);
  const state = readIndexState(index, sessionId);
  return !state || (state.retry_at !== null && state.retry_at <= now);
}

export function indexedTurnCount(sessionId: string): number {
  return ((readIndex() ?? sqlite).prepare('SELECT count(*) AS n FROM session_index_turns WHERE session_id = ?').get(sessionId) as { n: number }).n;
}

export function lastIndexedTurn(sessionId: string): TurnRow | null {
  return (readIndex() ?? sqlite).prepare(`SELECT turn_id, started_at, ended_at, initiator, outcome_kind, outcome_message FROM session_index_turns
    WHERE session_id = ? ORDER BY started_at IS NULL, started_at DESC LIMIT 1`).get(sessionId) as TurnRow | undefined ?? null;
}

export function indexSessionRecord(sessionId: string, source: IndexSource, options?: { backfill?: boolean; force?: boolean; respectRetry?: boolean }): Promise<IndexResult> {
  return run({ kind: 'read', sessionId, source, ...options });
}

const FLUSH_MS = 500;

/** The interactive timeline publishes changes; the worker owns all search projection and writes. */
export function followSessionIndex(sessionId: string, timeline: SessionTimeline, source: () => IndexSource): () => void {
  const changed = new Map<string, TranscriptTurn>();
  const removed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reset = false;
  let initial = true;
  const report = (error: unknown) => log.warn('sessionIndex: update failed', { sessionId, error: String(error) });
  const requestSnapshot = async (force: boolean) => indexSessionRecord(sessionId, source(), { force, backfill: true });
  const flush = () => {
    timer = undefined;
    if (initial || reset) {
      void requestSnapshot(reset).catch(report);
      initial = false;
    }
    if (changed.size || removed.size) {
      void run({ kind: 'update', sessionId, turns: [...changed.values()], removed: [...removed] }).catch(report);
    }
    reset = false;
    changed.clear();
    removed.clear();
  };
  timer = setTimeout(flush, FLUSH_MS);
  const stop = timeline.subscribe(timeline.getCursor(), result => {
    if (!result.ok) {
      reset = true;
      changed.clear();
      removed.clear();
    } else {
      for (const id of result.batch.removedTurnIds) { changed.delete(id); removed.add(id); }
      for (const turn of result.batch.turns) { changed.set(turn.id, turn); removed.delete(turn.id); }
    }
    timer ??= setTimeout(flush, FLUSH_MS);
  });
  const unfollow = () => {
    if (!followers.delete(unfollow)) return;
    stop();
    if (timer) { clearTimeout(timer); flush(); }
  };
  followers.add(unfollow);
  return unfollow;
}
