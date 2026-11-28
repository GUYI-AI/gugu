/**
 * A byte budget over kept copies, wherever they are kept (the page's Cache Storage, the desktop's file cache): from the
 * newest back, what fits stays and what does not is dropped. A dropped copy is read over the network again when wanted.
 */
/** budget: counted against the budget; keep: neither counted nor dropped (in use); drop: dropped outright. */
export type BudgetRole = 'budget' | 'keep' | 'drop'

/**
 * Trims `newestFirst` to the budget; returns the bytes left that count against it. `size` is asked only for a counted
 * entry. `drop` answering `false` did not drop (the copy is in use): it stays, and still counts.
 */
export async function trimToBytes<T>(newestFirst: Iterable<T>, maxBytes: number,
  entry: (item: T) => Promise<{ role: BudgetRole; size(): number | Promise<number> } | null>, drop: (item: T) => Promise<boolean | void>): Promise<number> {
  let kept = 0
  for (const item of newestFirst) {
    const found = await entry(item)
    if (!found || found.role === 'keep') continue
    const size = found.role === 'drop' ? 0 : await found.size()
    if (found.role !== 'drop' && kept + size <= maxBytes || await drop(item) === false) kept += size
  }
  return kept
}

/**
 * When to trim: not on every write. The bytes left by the last trim plus those written since are remembered, and `trim`
 * (which returns the bytes it kept) runs on the first write of a run, or once that sum is over the budget; a write that
 * comes while it runs is folded into one more round.
 */
export function byteBudget(maxBytes: number, trim: () => Promise<number>, onError: (error: unknown) => void) {
  let knownBytes: number | null = null
  let trimming: Promise<void> | null = null, again = false
  const run = (): Promise<void> => {
    if (trimming) { again = true; return trimming }
    trimming = (async () => {
      do { again = false; knownBytes = await trim() } while (again)
    })().finally(() => { trimming = null })
    return trimming
  }
  return {
    wrote(bytes: number): void {
      if (knownBytes !== null) knownBytes += bytes
      if (knownBytes === null || knownBytes > maxBytes) void run().catch(onError)
    },
    /** A copy that was in use was let go: what was over the budget only because of it can be dropped now. */
    released(): void { if (knownBytes !== null && knownBytes > maxBytes) void run().catch(onError) },
    /** The trim that is running, if one is; never starts one. */
    idle: (): Promise<void> => trimming ?? Promise.resolve(),
  }
}
