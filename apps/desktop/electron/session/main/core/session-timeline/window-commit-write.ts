import { randomUUID } from 'node:crypto';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import type { WindowLiveCursor } from './window-commit-journal';
import { writeWindowCommitSource } from './window-commit-source';
import { createWindowCommitReceipts, type WindowCommitReceipt, type WindowReceiptDatabase } from './window-commit-receipt';
import { beginWindowCommitIntent, recoverWindowCommitIntent, windowCommitIntentBinding } from './window-commit-intent';
import { writeWindowCommitSourceCatalog } from './window-commit-source-catalog';

export type WindowCommitCapture = {
  directory: string; scope: string; cursor: WindowLiveCursor;
  intentBudget?: WindowBudget;
  /** Canonical settlement is already authoritative; this callback publishes only after projection durability. */
  committed(receipt: WindowCommitReceipt | null): Promise<void>;
  phase?(name: 'source_durable' | 'canonical_committed', receipt: WindowCommitReceipt): void;
};

/** Runs inside the existing per-session writer chain, reusing its one serialized canonical value. */
export async function prepareWindowCommitWrite(connection: WindowReceiptDatabase, input: {
  sessionId: string; referenceId?: string; rowId: string; storedSeq: number; insert: boolean; serialized: string;
  capture?: WindowCommitCapture;
}): Promise<WindowCommitReceipt | undefined> {
  const capture = input.capture;
  if (!capture) return undefined;
  if (!input.referenceId) throw Object.assign(new Error('A captured commit needs its actual referenceId'), { code: 'live_identity_missing' });
  const scope = { directory: capture.directory, scope: capture.scope, sessionId: input.sessionId };
  await recoverWindowCommitIntent(connection, scope, capture.intentBudget ?? createWindowBudget());
  const current = { workerEpoch: capture.cursor.workerEpoch, storeEpoch: capture.cursor.storeEpoch, sequence: capture.cursor.sequence };
  const previous = createWindowCommitReceipts(connection).byRow(input.rowId), sourceId = randomUUID();
  const binding = windowCommitIntentBinding(capture.scope, sourceId);
  await beginWindowCommitIntent(scope, { version: 1, sourceId, sessionId: input.sessionId,
    rowId: input.rowId, referenceId: input.referenceId, storedSeq: input.storedSeq });
  const source = await writeWindowCommitSource(capture.directory, binding, input.serialized, undefined, true, sourceId);
  const prior = previous?.firstCommitCursor;
  const first = input.insert ? current : prior?.workerEpoch === current.workerEpoch && prior.storeEpoch === current.storeEpoch ? prior : null;
  const receipt: WindowCommitReceipt = { version: 1, sourceId, sessionId: input.sessionId, referenceId: input.referenceId,
    rowId: input.rowId, storedSeq: input.storedSeq, firstCommitCursor: first, latestRevisionCursor: current, binding, source };
  await writeWindowCommitSourceCatalog(capture.directory, receipt);
  capture.phase?.('source_durable', receipt);
  return receipt;
}

export function commitWindowReceipt(connection: WindowReceiptDatabase, receipt: WindowCommitReceipt | undefined): void {
  if (receipt) createWindowCommitReceipts(connection).put(receipt);
}
