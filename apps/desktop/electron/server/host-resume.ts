/** A retained process needs a cause-driven reconnect after the host resumes.
 * Inbox reconciliation is independent of realtime/auth recovery: a dead socket
 * must never hold the first unread pull behind its heartbeat timeout. */
export function createHostResumeHandler(deps: {
  pullUnread: () => Promise<void>
  reconnect: () => Promise<void>
  reconcile: () => Promise<void>
  notifyCommands: () => void
  observed: (source: string) => void
  failed: (operation: string, error: unknown) => void
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  let lastObserved = -Infinity
  return (source: string): void => {
    const at = now()
    // One wake announced twice in a row (a retried controller call) is one wake.
    if (at - lastObserved >= 0 && at - lastObserved < 1_000) return
    lastObserved = at
    deps.observed(source)
    for (const [operation, run] of [
      ['inbox', deps.pullUnread],
      ['realtime', deps.reconnect],
      ['credentials', deps.reconcile],
      ['commands', deps.notifyCommands],
    ] as const) {
      try {
        void Promise.resolve(run()).catch(error => deps.failed(operation, error))
      } catch (error) {
        deps.failed(operation, error)
      }
    }
  }
}

/** OS power events attest whole-device sleep; foreground and wall-clock gaps do not. */
export function installNativeSleepActivity(
  power: { on(event: 'suspend', callback: () => void): unknown; on(event: 'resume', callback: () => void): unknown },
  record: (sleep: { since: number; until: number; source: 'native-power' }) => void,
  now = Date.now,
): void {
  let since: number | null = null
  power.on('suspend', () => { since ??= now() })
  power.on('resume', () => {
    const until = now(), start = since; since = null
    if (start !== null && start < until) record({ since: start, until, source: 'native-power' })
  })
}
