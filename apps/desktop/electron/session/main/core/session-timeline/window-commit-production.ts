import { join } from 'node:path';
import { app } from 'electron';
import { sqlite } from '@main/db/client';
import { createWindowCommitReceipts, snapshotWindowCommitReceipt } from './window-commit-receipt';
import { createWindowCommitPublisher } from './window-commit-publisher';
import { ensureWindowCommitProjection, reserveWindowCommitHost as reserve } from './window-commit-host';

/** Bind the actual durable publisher before reserving the stopped-session
 * boundary. Preparing only creates scalar SQLite statements and a cold lease;
 * source/projection I/O starts on a real commit after onSpawned's tap barrier. */
export function reserveWindowCommitHost(...input: Parameters<typeof reserve>) {
  ensureWindowCommitProjection(() => {
    const receipts = createWindowCommitReceipts(sqlite);
    const publisher = createWindowCommitPublisher(join(app.getPath('userData'), 'session-window-cache', 'committed'), receipts);
    return async input => {
      const receipt = snapshotWindowCommitReceipt(input), expected = JSON.stringify(receipt);
      const { projectionId } = await publisher.publish(receipt);
      return { projectionId, validate() {
        if (JSON.stringify(receipts.bySource(receipt.sourceId)) !== expected)
          throw Object.assign(new Error('The canonical receipt changed before journal publication'), { code: 'needs_location' });
      } };
    };
  });
  return reserve(...input);
}
