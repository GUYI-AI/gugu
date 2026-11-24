import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createSessionRecordSource, createSessionTimeline, emptyRecordSource, type SessionRecordLocator } from '@gugu/session-core/session-record';
import type { HostTurnEnd } from '@gugu/session-core/session-record/host-turn-end';
import { createSessionIndexStore, openSessionIndex, readIndexState } from './store';

export type IndexSource = {
  locator: SessionRecordLocator | null;
  journal: SessionRecordLocator | null;
  hostEnds?: readonly HostTurnEnd[];
};

export type IndexCommand =
  | { kind: 'ready' }
  | { kind: 'read'; sessionId: string; source: IndexSource; force?: boolean; backfill?: boolean; respectRetry?: boolean }
  | { kind: 'delete'; sessionId: string }
  | { kind: 'update'; sessionId: string; turns: TranscriptTurn[]; removed: string[] };

export type IndexReply = { id: number; result: 'ready' | 'indexed' | 'unchanged' | 'missing' } | { id: number; error: string; name: string };

if (!parentPort) throw new Error('Session indexing must run in a worker');
const port = parentPort;
const database = (workerData as { database: string }).database;
const index = openSessionIndex(database);
const sessions = new Database(database, { readonly: true, timeout: 0 });
const active = sessions.prepare(`SELECT 1 FROM sessions s JOIN projects p ON p.id = s.project_id
  WHERE s.id = ? AND s.archived_at IS NULL AND p.workspace_provider = 'local'`);
const store = createSessionIndexStore(index);
const retryDelay = 24 * 60 * 60 * 1000;

async function read(job: Extract<IndexCommand, { kind: 'read' }>) {
  const { sessionId, source: { locator, journal, hostEnds } } = job;
  if (job.backfill && !active.get(sessionId)) return 'unchanged';
  const previous = readIndexState(index, sessionId);
  if (job.respectRetry && previous?.retry_at && previous.retry_at > Date.now()) return 'missing';
  const own = locator ?? journal;
  if (!own) return 'unchanged';
  const source = locator ? createSessionRecordSource(locator, { readMode: 'snapshot' }) : emptyRecordSource(own);
  const journalSource = journal ? createSessionRecordSource(journal, { readMode: 'snapshot' }) : undefined;
  const stamp = async () => {
    const [native, extra] = await Promise.all([source.stamp?.(), journalSource?.stamp?.()]);
    return (!locator || native) ? JSON.stringify([native, extra, hostEnds]) : null;
  };
  try {
    const before = await stamp();
    if (!job.force && before && before === previous?.stamp) return 'unchanged';
    const timeline = await createSessionTimeline(source, {
      sessionId,
      ...(journalSource ? { journal: journalSource } : {}),
      ...(hostEnds ? { hostTurnEnds: { read: () => hostEnds, subscribe: () => () => {} } } : {}),
    });
    try {
      const turns = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns;
      const after = await stamp();
      if (job.backfill && !active.get(sessionId)) return 'unchanged';
      store.replace(sessionId, turns, before === after ? before : null);
    } finally {
      timeline.dispose();
    }
    return 'indexed';
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'SessionRecordNotFoundError') throw error;
    store.failed(sessionId, Date.now() + retryDelay);

    if (job.backfill) return 'missing';
    throw error;
  }
}

let pending = Promise.resolve();
port.on('message', ({ id, command }: { id: number; command: IndexCommand }) => {
  pending = pending.then(async () => {
    try {
      if (command.kind === 'ready') port.postMessage({ id, result: 'ready' } satisfies IndexReply);
      else if (command.kind === 'read') port.postMessage({ id, result: await read(command) } satisfies IndexReply);
      else {
        if (command.kind === 'delete') store.drop(command.sessionId);
        else if (active.get(command.sessionId)) store.update(command.sessionId, command.turns, command.removed);
        port.postMessage({ id, result: 'indexed' } satisfies IndexReply);
      }
    } catch (error) {
      port.postMessage({ id, error: String(error), name: error instanceof Error ? error.name : 'Error' } satisfies IndexReply);
    }
  });
});
