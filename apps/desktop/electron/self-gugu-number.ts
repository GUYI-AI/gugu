/**
 * The signed-in account's own 咕咕号, read synchronously by App contexts (`operator.guguNumber`).
 *
 * Looked up once per account from the identity table (the lookup the delivery envelope already uses), the first time a
 * page asks. Until then the answer is `undefined`; when it arrives `changed` re-sends every page its context. A failed
 * lookup answers `null` and is said through `failed`; it is tried again on an ask a minute later.
 */
export const SELF_GUGU_NUMBER_RETRY_MS = 60_000

export function createSelfGuguNumber(deps: {
  userId: () => string | null
  lookup: (userId: string) => Promise<number | null>
  changed: () => void
  failed: (error: unknown) => void
  now?: () => number
}): () => number | null | undefined {
  const now = deps.now ?? Date.now
  let known: { userId: string; guguNumber: number | null } | null = null
  let failure: { userId: string; at: number } | null = null
  let pending: string | null = null
  return () => {
    const userId = deps.userId()
    if (!userId) return undefined
    if (known?.userId === userId) return known.guguNumber
    const failedHere = failure?.userId === userId
    if (pending !== userId && !(failedHere && now() - failure!.at < SELF_GUGU_NUMBER_RETRY_MS)) {
      pending = userId
      deps.lookup(userId).then(
        (guguNumber) => {
          if (deps.userId() !== userId) return
          known = { userId, guguNumber }
          failure = null
          deps.changed()
        },
        (error: unknown) => {
          const first = !failedHere
          failure = { userId, at: now() }
          deps.failed(error)
          if (first) deps.changed()
        },
      ).finally(() => {
        if (pending === userId) pending = null
      })
    }
    return failedHere ? null : undefined
  }
}
