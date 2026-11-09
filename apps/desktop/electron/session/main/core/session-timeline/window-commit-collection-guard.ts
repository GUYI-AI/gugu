import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import type { CommitSourceVersion } from './window-commit-pins';
import { snapshotWindowCommitReceipt } from './window-commit-receipt';
import { readWindowCommitIntent } from './window-commit-intent';
import { hasPendingWindowCommitBuild } from './window-commit-publisher';

/** Only disk intent state. A clear result does not prove that journal handoff,
 * resident ownership, or producer exclusion is complete. All producers must
 * acquire the same gateway's build/delivery pins before writing or publishing. */
export async function readWindowCommitCollectionGuard(directory: string, version: CommitSourceVersion,
  budget: WindowBudget, signal?: AbortSignal): Promise<'source_intent' | 'build_intent' | 'clear'> {
  const receipt = snapshotWindowCommitReceipt(version.receipt);
  const intent = await readWindowCommitIntent({ directory, scope: receipt.binding.scope, sessionId: receipt.sessionId }, budget, signal);
  if (intent?.sourceId === receipt.sourceId) return 'source_intent';
  return await hasPendingWindowCommitBuild({ directory, receipt }, budget, signal) ? 'build_intent' : 'clear';
}
