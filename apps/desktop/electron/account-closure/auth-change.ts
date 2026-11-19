import type { HumanAuthChangePermit } from '../runtime-auth-provider'
import { ClosureFailure } from './receipts'

interface Source { ownerId: string | null; generation: number }
interface Fence {
  underAuth<T>(operation: () => Promise<T>): Promise<T>
  requireAuthWrite(owner: string): Promise<void>
}
interface Ports {
  ready(): Promise<void>
  fence(): Fence
  source(): Source
  /** Qualification runs inside the lifecycle transition, before its first effect. */
  leave(source: string | null, next: string | null, qualify: () => Promise<void>): Promise<void>
}
export function createClosureAuthChange(ports: Ports) {
  return async (next: string | null): Promise<HumanAuthChangePermit> => {
    await ports.ready()
    const fence = ports.fence()
    const source = await fence.underAuth(async () => {
      if (next) await fence.requireAuthWrite(next)
      return ports.source()
    })
    const qualify = async () => {
      const current = ports.source()
      if (current.ownerId !== source.ownerId || current.generation !== source.generation) throw new ClosureFailure('scope_conflict')
      if (next) await fence.requireAuthWrite(next)
    }
    return {
      leave: () => ports.leave(source.ownerId, next, () => fence.underAuth(qualify)),
      mutate: operation => fence.underAuth(async () => { await qualify(); return operation() }),
    }
  }
}
