import type { WindowCommitCapture } from './window-commit-write';
import type { WindowCommitReceipt } from './window-commit-receipt';

const tails = new Map<string, Promise<void>>();

/** Canonical writes release their own tail before this ordered projection chain.
 * Only a bounded receipt and its owner callback cross this boundary, never a turn.
 * Runtime reservations count pending projections and published references together. */
export async function deliverWindowCommit(
  canonical: Promise<WindowCommitReceipt | undefined>,
  committed: WindowCommitCapture['committed'] | undefined,
): Promise<void> {
  const receipt = await canonical;
  if (!committed) return;
  if (!receipt) return committed(null);
  const run = () => committed(receipt);
  const next = (tails.get(receipt.sessionId) ?? Promise.resolve()).then(run, run);
  const tail = next.then(() => undefined, () => undefined);
  tails.set(receipt.sessionId, tail);
  try { await next; }
  finally { if (tails.get(receipt.sessionId) === tail) tails.delete(receipt.sessionId); }
}
