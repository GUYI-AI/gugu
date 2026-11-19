import type { LegAdapter } from './session-life-adapter'

interface OwnedRun {
  pending: Set<Promise<unknown>>
  resources: Map<string, unknown>
  failed: boolean
}

/** Additional proof for destructive account cleanup. Normal lifecycle stops can
 * settle before an aborted start returns; cleanup must also wait for that late
 * result's teardown, including runs already removed from the visible list.
 */
export class SessionLifeOwnerDrain {
  private readonly owners = new Map<string, Set<OwnedRun>>()

  track(ownerId: string, adapter: LegAdapter): LegAdapter {
    const run: OwnedRun = { pending: new Set(), resources: new Map(), failed: false }
    const publish = () => {
      if (run.pending.size || run.resources.size || run.failed) {
        const runs = this.owners.get(ownerId) ?? new Set<OwnedRun>()
        runs.add(run)
        this.owners.set(ownerId, runs)
      } else {
        const runs = this.owners.get(ownerId)
        runs?.delete(run)
        if (runs?.size === 0) this.owners.delete(ownerId)
      }
    }
    const during = <T>(operation: () => Promise<T>): Promise<T> => {
      // Register before invoking an adapter: synchronous completion or failure
      // must not leave a window in which cleanup observes no admitted work.
      const pending = Promise.resolve().then(operation)
      run.pending.add(pending)
      publish()
      void pending.then(() => { run.pending.delete(pending); publish() }, () => { run.pending.delete(pending); publish() })
      return pending
    }
    return {
      leg: adapter.leg,
      timing: adapter.timing,
      run: (at, have, context) => during(async () => {
        const resource = await adapter.run(at, have, context)
        if (at !== 'identity') run.resources.set(at, resource)
        return resource
      }),
      dispatch: (have, row, context) => during(() => adapter.dispatch(have, row, context)),
      teardown: (have, context) => during(async () => {
        try { await adapter.teardown(have, context) }
        catch (error) { run.failed = true; throw error }
        for (const [stage, resource] of Object.entries(have)) if (run.resources.get(stage) === resource) run.resources.delete(stage)
        if (run.resources.size === 0) run.failed = false
        if (adapter.closureDrain) {
          const proof = during(async () => {
            try { await adapter.closureDrain!() }
            catch (error) { run.failed = true; throw error }
          })
          // Normal stop keeps its existing responsiveness; destructive cleanup
          // observes this same proof through the owner's pending operations.
          void proof.catch(() => undefined)
        }
      }),
      onExit: (have, callback) => adapter.onExit(have, callback),
    }
  }

  /** Call after the owner-scoped lifecycle interrupt has drained. A failure is
   * retained as unconfirmed rather than mistaking a removed row for an exit.
   */
  async drain(ownerId: string): Promise<void> {
    for (;;) {
      const runs = [...this.owners.get(ownerId) ?? []]
      const pending = runs.flatMap(run => [...run.pending])
      if (pending.length) { await Promise.allSettled(pending); continue }
      if (runs.some(run => run.failed || run.resources.size)) throw new Error('Account runtime exit is unconfirmed')
      return
    }
  }
}
