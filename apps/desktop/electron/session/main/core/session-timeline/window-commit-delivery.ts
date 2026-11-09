import type { WindowCommitCapture } from './window-commit-write';
import type { WindowCommitReceipt } from './window-commit-receipt';

const deliveries = new Map<string, { sessionId: string; done: Promise<void> }>();
export function pendingWindowCommitDelivery(sessionId: string, sourceId: string): Promise<void> | undefined {
  const pending = deliveries.get(sourceId);
  return pending?.sessionId === sessionId ? pending.done : undefined;
}

/** Preparation may overlap after canonical settlement. Runtime preserves commit
 * publication order separately, so a slow projection never serializes admission
 * into the next projection group or blocks the canonical tail. An admitted
 * delivery stays observable to Position until its projection settles. */
export async function deliverWindowCommit(
  canonical: Promise<WindowCommitReceipt | undefined>,
  committed: WindowCommitCapture['committed'] | undefined,
): Promise<void> {
  const receipt = await canonical;
  if (!committed) return;
  if (!receipt) return committed(null);
  const done = Promise.resolve().then(() => committed(receipt)), delivery = { sessionId: receipt.sessionId, done };
  deliveries.set(receipt.sourceId, delivery);
  try { await done; }
  finally { if (deliveries.get(receipt.sourceId) === delivery) deliveries.delete(receipt.sourceId); }
}
