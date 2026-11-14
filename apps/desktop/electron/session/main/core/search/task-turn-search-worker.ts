import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { matchTaskTurns } from './task-turn-matches';

// The thread task-turn search runs on (task-turn-search.ts starts it), with a read-only connection of its own.
const port = parentPort;
if (!port) throw new Error('task-turn-search: must run inside a worker thread');
const connection = new Database((workerData as { database: string }).database, { readonly: true });
port.on('message', ({ id, query, limit }: { id: number; query: string; limit?: number }) => {
  try { port.postMessage({ id, matches: matchTaskTurns(connection, query, limit) }); }
  catch (error) { port.postMessage({ id, error: String(error) }); }
});
