import { createHash, randomUUID } from 'node:crypto'
import type { AccountClosureScope } from '../../src/platform/accountClosure'
import { createClosureAuthBarrier } from './auth-barrier'
import { ClosureFailure, createDesktopClosureReceipts, scopeOf, type DesktopClosureReceiptPorts } from './receipts'

interface Fence { version: 1; operation: string; epoch: string; active: boolean; ready: boolean; paused: boolean; erasing: boolean }
export interface DesktopClosureServicePorts extends Omit<DesktopClosureReceiptPorts, 'underAuth' | 'installation' | 'preparation' | 'beforeErase'> {
  /** Native profile binding, never supplied by renderer IPC. */
  profileBinding: string
  /** Drain only this owner's admitted work; a concurrent B must never be stopped. */
  stopOwner(ownerId: string): Promise<void>
  /** Re-read native ownership proof immediately before any destructive effect. */
  recheckStopped?(ownerId: string): Promise<void>
}
const unavailable = (): never => { throw new ClosureFailure('closure_storage_unavailable') }
const conflict = (): never => { throw new ClosureFailure('scope_conflict') }

/** Main-process only preparation and protected receipt store. Cancelling a
 * failed operation removes its seal but deliberately does not resume Agents.
 */
export function createDesktopClosureService(ports: DesktopClosureServicePorts) {
  const underAuth = createClosureAuthBarrier()
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const binding = digest(ports.profileBinding)
  const installationKey = `account-closure-installation:${binding}`
  async function installation(create = false) {
    const stored = await ports.secrets.getSecret(installationKey)
    if (stored !== null) {
      const value = JSON.parse(stored) as { version?: number; id?: string; binding?: string }
      if (value.version !== 1 || value.binding !== binding || typeof value.id !== 'string'
        || !/^[a-f0-9-]{36}$/.test(value.id)) return unavailable()
      return value.id
    }
    if (!create) return null
    const id = randomUUID()
    await ports.secrets.setSecret(installationKey, JSON.stringify({ version: 1, id, binding }))
    return id
  }
  // Normal Agent admission must not create a protected installation record.
  // An absent fence can be read without requiring a new safeStorage write.
  const fenceKey = (ownerId: string) => `account-closure-preparation:${digest(JSON.stringify([binding, ownerId]))}`
  async function readFence(ownerId: string): Promise<Fence | null> {
    const raw = await ports.secrets.getSecret(fenceKey(ownerId))
    if (raw === null) return null
    const value = JSON.parse(raw) as Partial<Fence>
    if (value.version !== 1 || typeof value.operation !== 'string' || !value.operation || value.operation.length > 256
      || typeof value.epoch !== 'string' || !/^[a-f0-9-]{36}$/.test(value.epoch)
      || typeof value.active !== 'boolean' || typeof value.ready !== 'boolean' || typeof value.paused !== 'boolean'
      || typeof value.erasing !== 'boolean') return unavailable()
    return value as Fence
  }
  const writeFence = async (owner: string, fence: Fence) => ports.secrets.setSecret(fenceKey(owner), JSON.stringify(fence))
  const native = createDesktopClosureReceipts({ ...ports, underAuth, installation,
    async preparation(scope) {
      const fence = await readFence(scope.ownerId)
      if (!fence?.active) throw new ClosureFailure('closure_not_prepared')
      if (fence.operation !== scope.localOperationId) return conflict()
      return { epoch: fence.epoch, ready: fence.ready }
    },
    async beforeErase(scope) {
      const fence = await readFence(scope.ownerId)
      if (!fence?.active || !fence.ready || fence.operation !== scope.localOperationId) throw new ClosureFailure('closure_not_prepared')
      await ports.recheckStopped?.(scope.ownerId)
      if (!fence.erasing) await writeFence(scope.ownerId, { ...fence, erasing: true })
    },
  })
  const own = async (scope: AccountClosureScope) => {
    if (await ports.currentOwner() !== scope.ownerId) throw new ClosureFailure('wrong_local_owner')
  }
  return {
    native, underAuth,
    async prepare(input: AccountClosureScope, nativeGeneration?: string): Promise<{ prepared: true }> {
      // The optional generation is supplied only by native V2 custody. Legacy
      // renderer IPC forwards the scope alone and cannot assert this argument.
      if (nativeGeneration !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(nativeGeneration)) throw new ClosureFailure('invalid_scope')
      const scope = scopeOf(input)
      const epoch = await underAuth(async () => {
        await own(scope)
        if (await native.receipt.get(scope) === null) throw new ClosureFailure('receipt_missing')
        let fence = await readFence(scope.ownerId)
        if (fence?.erasing) throw new ClosureFailure('closure_not_prepared')
        if (fence?.active && (fence.operation !== scope.localOperationId || nativeGeneration !== undefined && fence.epoch !== nativeGeneration)) return conflict()
        if (!fence?.active) {
          fence = { version: 1, operation: scope.localOperationId, epoch: nativeGeneration ?? randomUUID(), active: true, ready: false, paused: true, erasing: false }
          await writeFence(scope.ownerId, fence)
        }
        // Capture may precede preparation (the challenge already returned its
        // receipt). Bind only the native fence, before any stop can fail.
        await native.bindPreparation(scope)
        return fence.epoch
      })
      // Draining work can itself read native auth. Never hold the identity
      // barrier while awaiting an already admitted runtime's exit.
      try { await ports.stopOwner(scope.ownerId) }
      catch { throw new ClosureFailure('closure_not_prepared') }
      return underAuth(async () => {
        await own(scope)
        await ports.recheckStopped?.(scope.ownerId)
        const fence = await readFence(scope.ownerId)
        if (!fence?.active || fence.operation !== scope.localOperationId || fence.epoch !== epoch) return conflict()
        await writeFence(scope.ownerId, { ...fence, ready: true })
        return { prepared: true }
      })
    },
    async cancel(input: AccountClosureScope): Promise<{ cancelled: true }> {
      const scope = scopeOf(input)
      return underAuth(async () => {
        await own(scope)
        const epoch = await native.requireCancelledPreparation(scope)
        const fence = await readFence(scope.ownerId)
        if (!fence || fence.erasing || fence.operation !== scope.localOperationId || fence.epoch !== epoch) return conflict()
        await writeFence(scope.ownerId, { ...fence, active: false, ready: false })
        return { cancelled: true }
      })
    },
    /** Private V2 receiver only: callers have already persisted the exact
     * authoritative cancellation ACK. Never registered as a renderer command. */
    async releaseNativePreparation(input: AccountClosureScope, epoch: string): Promise<void> {
      const scope = scopeOf(input)
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(epoch)) throw new ClosureFailure('invalid_scope')
      await underAuth(async () => {
        const owner = await ports.currentOwner()
        if (owner === undefined) return unavailable()
        if (owner !== null && owner !== scope.ownerId) throw new ClosureFailure('wrong_local_owner')
        const fence = await readFence(scope.ownerId)
        const matching = fence?.operation === scope.localOperationId && fence.epoch === epoch
        if (fence && (fence.erasing || fence.active && !matching)) return conflict()
        try { await native.receipt.remove(scope) }
        catch (error) { if (!(error instanceof ClosureFailure) || error.code !== 'closure_context_missing') throw error }
        if (fence && matching) await writeFence(scope.ownerId, { ...fence, active: false, ready: false })
      })
    },
    /** Used by main's runtime and session admission, including after restart. */
    isPaused: async (owner: string) => (await readFence(owner))?.paused === true,
    isSealed: async (owner: string) => (await readFence(owner))?.active === true,
    /** Main's auth mirror writer checks this under the same short barrier. */
    async requireAuthWrite(owner: string) {
      if ((await readFence(owner))?.erasing) throw new ClosureFailure('closure_not_prepared')
    },
  }
}
