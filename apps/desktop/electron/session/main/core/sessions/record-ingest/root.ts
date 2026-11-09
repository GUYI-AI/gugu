import { join } from 'node:path';

/**
 * Where record ingestion keeps what it writes for the host (resume-mem): checkpoints, spills, and the pictures it copies
 * out of a record (`pictures/<session>/<sha256>`), so a picture's bytes never pass through the host process.
 */
let override: string | null = null;

export function setRecordIngestRoot(root: string | null): void {
  override = root;
}

export async function recordIngestRoot(): Promise<string> {
  return override ?? join((await import('electron')).app.getPath('userData'), 'record-ingest');
}

/** The kv namespace of the per-session ingest cursor (`record-backfill.ts`); a revert drops it with the rows. */
export const RECORD_INGEST_KV = 'record-ingest';

export const recordPicturesDir = (root: string, sessionId: string) => join(root, 'pictures', sessionId);
