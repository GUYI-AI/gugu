import type { WindowCommitCapture } from './window-commit-write';
import type { WindowCommitReceipt } from './window-commit-receipt';

/** Preparation may overlap after canonical settlement. Runtime preserves commit
 * publication order separately, so a slow projection never serializes admission
 * into the next projection group or blocks the canonical tail. */
export async function deliverWindowCommit(
  canonical: Promise<WindowCommitReceipt | undefined>,
  committed: WindowCommitCapture['committed'] | undefined,
): Promise<void> {
  const receipt = await canonical;
  if (committed) await committed(receipt ?? null);
}
