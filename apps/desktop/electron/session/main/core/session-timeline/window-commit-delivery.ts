import type { WindowCommitCapture } from './window-commit-write';
import type { WindowCommitReceipt } from './window-commit-receipt';

const deliveries = new Map<string, { sessionId: string; done: Promise<void> }>();
/** Wait only for an admitted source job. The runtime's pending capacity also
 * bounds this map; a position lookup never starts a build or replays a turn. */
export function pendingWindowCommitDelivery(sessionId: string, sourceId: string): Promise<void> | undefined {
  const delivery = deliveries.get(sourceId);
  return delivery?.sessionId === sessionId ? delivery.done : undefined;
}
/** Preparation overlaps after canonical settlement. Runtime orders publication
 * separately so one source's build never serializes admission of the next. */
export async function deliverWindowCommit(
  canonical: Promise<WindowCommitReceipt | undefined>,
  committed: WindowCommitCapture['committed'] | undefined,
): Promise<void> {
  const receipt = await canonical;
  if (!committed) return;
  if (!receipt) return committed(null);
  const delivery = { sessionId: receipt.sessionId, done: Promise.resolve().then(() => committed(receipt)) };
  deliveries.set(receipt.sourceId,delivery);
  try { await delivery.done; }
  finally { if (deliveries.get(receipt.sourceId) === delivery) deliveries.delete(receipt.sourceId); }
}
