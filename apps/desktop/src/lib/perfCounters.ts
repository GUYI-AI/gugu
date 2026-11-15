import type { PerfCounters } from '../session/shared/renderer-metrics'

// Counts attempts, including failed transactions/RPCs and React render attempts.
// No timers, subscriptions, clocks, logging, or allocations on the write path.
let imTransactions = 0
let presenceBatches = 0
let presenceIds = 0
let contactsProviderRenders = 0
let snapshotRefusals = 0

export function recordImTransaction(): void { imTransactions += 1 }
export function recordPresenceBatch(ids: number): void { presenceBatches += 1; presenceIds += ids }
export function recordContactsRender(): void { contactsProviderRenders += 1 }
/** A replica entry that could not be kept across restarts (over its limit, or the storage refused the block). */
export function recordSnapshotRefusal(): void { snapshotRefusals += 1 }

export function readPerfCounters(): PerfCounters {
  return { imTransactions, presenceBatches, presenceIds, contactsProviderRenders, snapshotRefusals }
}
