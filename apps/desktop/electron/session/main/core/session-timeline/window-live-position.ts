import { join } from 'node:path';
import { app } from 'electron';
import { sqlite } from '@main/db/client';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowLivePositionRequest, WindowLivePositionResult } from '@gugu/session-wire/session-window-live';
import { withStoredTurns } from '../sessions/session-turn-store';
import { pendingWindowCommitDelivery } from './window-commit-delivery';
import { lookupWindowCommitPosition } from './window-commit-position';
import { readWindowCommitPublication } from './window-commit-publisher';
import { createWindowCommitReceipts, snapshotWindowCommitReceipt } from './window-commit-receipt';
import { assertWindowCommitSourceNow } from './window-commit-source';
import type { WindowOpeningLease } from './window-opening';
import { windowPackProof } from './window-pack-store';

const missing = () => Object.assign(new Error('The durable position changed or is not available'), { code: 'needs_location' });
/** No build, scan or runtime start. The returned closure is consumed in the
 * service's final synchronous return turn, after its owner check. */
export async function prepareWindowLivePosition(lease: WindowOpeningLease, input: WindowLivePositionRequest)
  : Promise<() => WindowLivePositionResult> {
  const { conversationId, referenceId } = input, applied = { ...input.appliedCursor };
  const budget = createWindowBudget(), receipts = createWindowCommitReceipts(sqlite);
  const directory = join(app.getPath('userData'), 'session-window-cache', 'committed');
  let verify: (() => void) | undefined;
  const result = await lookupWindowCommitPosition(lease, input, {
    durable: async signal => {
      const stored = await withStoredTurns(conversationId, async () => { lease.sample(applied); return receipts.byReference(conversationId, referenceId); });
      if (!stored) return null;
      const receipt = snapshotWindowCommitReceipt(stored), expected = JSON.stringify(receipt);
      await pendingWindowCommitDelivery(conversationId, receipt.sourceId); lease.sample(applied);
      const checks: (() => void)[] = [];
      const publication = await readWindowCommitPublication({ directory, receipts, receipt }, budget, signal,
        key => checks.push(windowPackProof(directory, key)));
      if (checks.length !== 2) throw missing();
      verify = () => {
        try { checks.forEach(check => check()); assertWindowCommitSourceNow(directory, receipt.binding, receipt.source); }
        catch { throw missing(); }
        if (JSON.stringify(receipts.bySource(receipt.sourceId)) !== expected) throw missing();
      };
      return { kind: 'committed', position: { projectionId: publication.projectionId, rowId: receipt.rowId,
        storedSeq: receipt.storedSeq, referenceId }, firstCommitCursor: receipt.firstCommitCursor, latestRevisionCursor: receipt.latestRevisionCursor };
    },
    primaryActive: async signal => {
      const { peekAcpWorkerClient } = await import('../acp/runtime-process/host');
      const client = await peekAcpWorkerClient(); lease.sample(applied);
      return client ? client.windowActiveReference({ sessionId: conversationId, referenceId }, { signal }) : false;
    },
  });
  return () => { lease.sample(applied); if (result.kind === 'committed') { if (!verify) throw missing(); verify(); } return result; };
}
