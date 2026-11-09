import { spawnWorker } from '@gugu/session-wire/worker';
import { appScope } from '@main/app/app-scope';
import { desktopWorkerPath } from '@main/worker-manifest';
import { recordIngestContract } from './contract';
import type { IngestBatch, IngestRequest, IngestSummary } from './plan';

export type IngestSession = { summary: IngestSummary; next(): Promise<IngestBatch | null>; dispose(): Promise<void> };
export type IngestRunner = (request: IngestRequest) => Promise<IngestSession>;

/** The ingest child's heap ceiling: it holds hashed identities and one reducer tail, never the record. */
const INGEST_HEAP_MIB = 256;

/**
 * One ingest, one child process (resume-mem): the record is decoded there, never on the host. The process is disposed
 * after every ingest, so a crash, an OOM or a hang costs one ingest and the next one gets a fresh process.
 */
export const childProcessIngest: IngestRunner = async (request) => {
  const handle = await spawnWorker({
    name: 'record-ingest',
    contract: recordIngestContract,
    entry: desktopWorkerPath('record-ingest'),
    scope: appScope.child('record-ingest'),
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${INGEST_HEAP_MIB}`.trim() },
    supervision: { restart: 'never' },
  });
  try {
    const summary = await handle.client.start(request);
    return { summary, next: () => handle.client.next({}), dispose: () => handle.dispose() };
  } catch (error) {
    await handle.dispose();
    throw error;
  }
};
