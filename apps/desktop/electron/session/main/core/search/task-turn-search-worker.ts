import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { sessionIndexPath } from '../session-index/store';
import { parentPort, workerData } from 'node:worker_threads';
import { matchTaskTurns } from './task-turn-matches';

// The thread task-turn search runs on (task-turn-search.ts starts it), with a read-only connection of its own.
const port = parentPort;
if (!port) throw new Error('task-turn-search: must run inside a worker thread');
const database = (workerData as { database: string }).database;
const connection = new Database(database, { readonly: true });
const indexPath = sessionIndexPath(database);
let attached = false;
function searchSchema(): 'main' | 'history_search' {
  if (!attached && existsSync(indexPath)) {
    connection.prepare('ATTACH DATABASE ? AS history_search').run(indexPath);
    attached = true;
  }
  return attached && connection.pragma('history_search.user_version', { simple: true }) === 1 ? 'history_search' : 'main';
}
port.on('message', ({ id, query, limit, offset }: { id: number; query: string; limit?: number; offset?: number }) => {
  try { port.postMessage({ id, matches: matchTaskTurns(connection, query, limit, offset, searchSchema()) }); }
  catch (error) { port.postMessage({ id, error: String(error) }); }
});
