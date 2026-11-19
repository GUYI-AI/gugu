import { randomUUID } from 'node:crypto'
import type { AccountClosureV2Confirmation, AccountClosureV2Handle, AccountClosureV2Native, AccountClosureV2Snapshot } from '../../src/platform/accountClosureV2'
import type { createClosureOperationRecords, ClosureOperationRecord } from './operation-record'
import type { createDesktopClosureService } from './service'
import { ClosureV2HttpFailure, isMatchingClosureRejection, type ClosureV2Auth, type ClosureV2Binding, type ClosureV2Reply, type ClosureV2Route, type createClosureV2Http } from './v2-http'

interface Ports {
  records: ReturnType<typeof createClosureOperationRecords>
  local: ReturnType<typeof createDesktopClosureService>
  http: ReturnType<typeof createClosureV2Http>
  auth(): Promise<ClosureV2Auth | null | undefined>
  deviceId(): Promise<string>
  resumeOwner(ownerId: string): Promise<void>
}
const fail = (code: ConstructorParameters<typeof ClosureV2HttpFailure>[0]): never => { throw new ClosureV2HttpFailure(code) }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const localScope = (r: ClosureOperationRecord) => ({ ownerId: r.ownerId, localOperationId: r.cleanupScopeId })
const binding = (r: ClosureOperationRecord): ClosureV2Binding => {
  if (!r.receipt) return fail('receipt_missing')
  return { ownerId: r.ownerId, sessionId: r.sessionId, localOperationId: r.localOperationId, receipt: r.receipt,
    serverOperationId: r.serverOperationId, nativeGeneration: r.nativeGeneration, serverGeneration: r.serverGeneration,
    challengeGeneration: r.confirmationGeneration ?? r.challengeGeneration, confirmationId: r.confirmationId }
}

/** Native command receiver. Capability, original identity, HTTP intent and local
 * cleanup checkpoints never come from renderer claims. Network/drain work runs
 * outside the short identity barrier; receiving it still requires the same CAS.
 */
export function createDesktopClosureV2Service(p: Ports): AccountClosureV2Native & { resumePausedAgents(): Promise<void> } {
  let busy = false
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    if (busy) return fail('closure_busy')
    busy = true
    try { return await work() } finally { busy = false }
  }
  const snapshot = (r: ClosureOperationRecord): Promise<AccountClosureV2Snapshot> => p.local.underAuth(async () => {
    const checked = await p.records.readNative(r)
    if (checked.revision !== r.revision) return fail('scope_conflict')
    return ({
    handle: { localOperationId: r.localOperationId, nativeGeneration: r.nativeGeneration, localRevision: r.revision },
    ownerId: r.ownerId, phase: r.phase,
    serverOperation: r.serverOperationId && r.serverState ? { operationId: r.serverOperationId, state: r.serverState,
      operationRevision: r.serverRevision, challengeGeneration: r.challengeGeneration, challengeExpiresAt: r.serverRequest?.id === r.requestId && r.serverRequest.state === 'challenge' && r.serverRequest.lastError === null
        && (r.pendingChallengeGeneration === null || r.pendingChallengeGeneration === r.challengeGeneration) ? r.serverRequest.expiresAt : null } : null,
    serverPreparationGeneration: r.serverGeneration, recoveryOnly: r.recoveryOnly, pendingEffect: r.pendingEffect,
    confirmCancellationBlocked: r.pendingEffect === 'confirm' && r.confirmCancellationBlocked === true,
    agentsPaused: await p.local.isPaused(r.ownerId), retainedUnattributed: [...r.retainedUnattributed],
    })
  })
  async function current(handle: AccountClosureV2Handle): Promise<ClosureOperationRecord> {
    if (!handle || !uuid(handle.localOperationId) || !uuid(handle.nativeGeneration) || !Number.isSafeInteger(handle.localRevision) || handle.localRevision < 1) return fail('invalid_scope')
    const found = await p.records.discover()
    if (!found) return fail('closure_context_missing')
    if (found.localOperationId !== handle.localOperationId || found.nativeGeneration !== handle.nativeGeneration || found.revision !== handle.localRevision) return fail('scope_conflict')
    return p.records.readNative(found)
  }
  async function live(r?: ClosureOperationRecord): Promise<ClosureV2Auth> {
    const auth = await p.auth()
    if (auth === undefined) return fail('closure_storage_unavailable')
    if (!auth) return fail('unauthorized')
    if (r && (auth.ownerId !== r.ownerId || auth.sessionId !== r.sessionId)) return fail('wrong_local_owner')
    return auth
  }
  const update = (r: ClosureOperationRecord, change: (r: ClosureOperationRecord) => void) => p.records.updateNative(r, change)
  async function claim(r: ClosureOperationRecord, effect: ClosureOperationRecord['pendingEffect'], change: (r: ClosureOperationRecord) => void = () => {}) {
    return p.local.underAuth(async () => {
      const auth = await live(r)
      const next = await update(r, value => { change(value); value.pendingEffect = effect; value.recoveryOnly = true })
      return { record: next, auth }
    })
  }
  function releaseProof(r: ClosureOperationRecord): boolean {
    return r.serverState === 'closed_before_confirm' && r.canReleasePreparation === true && r.serverCancelled
  }
  async function settle(r: ClosureOperationRecord): Promise<ClosureOperationRecord> {
    if (r.serverState === 'deleted') {
      if (!r.localPreparationStarted || !r.serverGeneration || !r.serverPrepared) return fail('closure_not_prepared')
      const result = await p.local.native.eraseLocal(localScope(r))
      r = await update(r, value => {
        value.retainedUnattributed = [...result.retainedUnattributed]
        value.phase = result.status === 'complete' ? 'local-complete' : 'deleted'
        value.recoveryOnly = result.status !== 'complete'; value.pendingEffect = null
      })
    } else if (releaseProof(r)) {
      if (r.localPreparationStarted) await p.local.releaseNativePreparation(localScope(r), r.nativeGeneration)
      r = await update(r, value => { value.phase = 'cancelled'; value.pendingConfirmCancellation = false; value.confirmCancellationBlocked = false; value.pendingEffect = null; value.recoveryOnly = false; value.receipt = null })
    }
    return r
  }
  async function receive(r: ClosureOperationRecord, reply: ClosureV2Reply): Promise<ClosureOperationRecord> {
    const o = reply.operation, prep = reply.preparation
    if (r.serverOperationId && r.serverOperationId !== o.id || o.revision < r.serverRevision || o.challengeGeneration < r.challengeGeneration
      || r.serverState === 'deleted' && o.state !== 'deleted' || r.serverState === 'closed_before_confirm' && o.state !== 'closed_before_confirm') return fail('scope_conflict')
    if (prep && (prep.nativeGeneration !== r.nativeGeneration || r.serverGeneration !== null && prep.serverGeneration !== r.serverGeneration)) return fail('scope_conflict')
    const rejected = isMatchingClosureRejection(reply, binding(r))
    const next = await update(r, value => {
      value.serverOperationId = o.id; value.serverRevision = o.revision; value.serverState = o.state
      value.challengeGeneration = o.challengeGeneration; value.requestId = o.requestId; value.serverRequestState = o.requestState; value.serverRequest = o.request
      value.serverConfirmation = o.confirmation; value.canReleasePreparation = o.canReleasePreparation
      if (prep) {
        value.serverGeneration = prep.serverGeneration
        value.serverPrepared = prep.prepared === true
        value.serverCancelled = prep.cancelled === true
      }
      // Absence of a preparation is never evidence of cancellation.
      if (o.state === 'deleted') { value.phase = 'deleted'; value.pendingEffect = null; value.recoveryOnly = true }
      else if (o.state === 'processing') { value.phase = 'processing'; value.recoveryOnly = true }
      else if (o.state === 'confirming') { value.phase = 'confirming'; value.recoveryOnly = true }
      else if (o.state === 'closed_before_confirm') { value.phase = 'cancel-pending'; value.recoveryOnly = true }
      else if (value.pendingEffect === 'confirm') {
        if (rejected) {
          value.pendingEffect = null; value.recoveryOnly = false; value.pendingConfirmCancellation = false; value.confirmCancellationBlocked = false
          value.phase = value.serverPrepared ? 'prepared' : 'challenge'
        } // open/422 alone cannot clear an unknown confirmation.
      } else if (value.pendingEffect === 'cancel') {
        value.phase = 'cancel-pending'; value.recoveryOnly = true
      } else if (value.pendingEffect === 'prepare_device') {
        if (prep?.prepared === true && prep.serverGeneration !== null && value.localPreparationStarted) {
          value.phase = 'prepared'; value.pendingEffect = null; value.recoveryOnly = false
        }
      } else if (value.pendingEffect === 'challenge') {
        if (o.challengeGeneration === value.pendingChallengeGeneration && o.requestState === 'challenge' && o.request?.id === o.requestId && o.request.lastError === null) {
          value.phase = 'challenge'; value.pendingEffect = null; value.recoveryOnly = false; value.pendingChallengeGeneration = null
        }
      } else if (value.pendingEffect === 'register') {
        value.phase = 'registered'; value.pendingEffect = null; value.recoveryOnly = false
      }
    })
    return settle(next)
  }
  async function request(r: ClosureOperationRecord, route: ClosureV2Route, extra: Record<string, string | number | boolean | null>, auth?: ClosureV2Auth) {
    let reply: ClosureV2Reply
    try { reply = await p.http.post(route, binding(r), extra, auth) }
    catch (error) {
      if (error instanceof ClosureV2HttpFailure && error.rejection) {
        await receive(r, error.rejection) // Matching proof is atomically durable before UI sees rejection.
      }
      throw error
    }
    return receive(r, reply)
  }
  const recoverRecord = (r: ClosureOperationRecord) => request(r, 'result', {})
  return {
    resumePausedAgents: () => exclusive(async () => {
      const owner = await p.local.underAuth(async () => {
        const auth = await live(), record = await p.records.currentNative()
        if (!record || record.phase !== 'cancelled') return fail('closure_not_complete')
        await p.local.resumeCancelledOwner(auth.ownerId)
        return auth.ownerId
      })
      // The lifecycle transition requalifies identity before starting work. It
      // runs outside the identity barrier, like the corresponding stop/drain.
      await p.resumeOwner(owner)
    }),
    readPolicy: async () => {
      const auth = await p.local.underAuth(() => live())
      const policy = await p.http.policy(auth)
      return p.local.underAuth(async () => {
        const current = await live()
        if (current.ownerId !== auth.ownerId || current.sessionId !== auth.sessionId) return fail('wrong_local_owner')
        return policy
      })
    },
    discover: async () => {
      const found = await p.records.discover()
      return found ? snapshot(await p.records.readNative(found)) : null
    },
    capture: () => exclusive(async () => {
      const found = await p.records.begin()
      return snapshot(await p.records.readNative(found, true))
    }),
    sendCode: handle => exclusive(async () => {
      let r = await current(handle)
      if (r.recoveryOnly || r.pendingEffect || !['captured', 'registered', 'challenge', 'prepared'].includes(r.phase)) return fail('closure_recovery_required')
      if (!r.serverOperationId) {
        const c = await claim(r, 'register'); r = await request(c.record, 'register', { consent_version: 'immediate-forfeit-v1' }, c.auth)
      }
      if (r.serverState !== 'open') return fail('closure_recovery_required')
      const generation = r.challengeGeneration + 1
      if (generation > 2147483647) return fail('state_conflict')
      const c = await claim(r, 'challenge', value => { value.pendingChallengeGeneration = generation })
      return snapshot(await request(c.record, 'challenge', { consent_version: 'immediate-forfeit-v1', generation }, c.auth))
    }),
    prepare: handle => exclusive(async () => {
      let r = await current(handle)
      if (r.recoveryOnly || r.pendingEffect || r.serverState !== 'open' || !r.requestId || r.serverRequestState !== 'challenge') return fail('closure_recovery_required')
      if (!r.serverRequest || r.serverRequest.id !== r.requestId || Date.parse(r.serverRequest.expiresAt) <= Date.now()) return fail('state_conflict')
      if (r.phase === 'prepared' && r.serverGeneration && r.serverPrepared) return snapshot(r)
      const c = await claim(r, 'prepare_device', value => { value.localPreparationStarted = true })
      r = c.record
      // This marker is not a cloud capability and its private scope is not public.
      await p.local.native.receipt.put(localScope(r), 'local-v2')
      await p.local.prepare(localScope(r), r.nativeGeneration)
      r = await update(r, value => { value.phase = 'local-prepared' })
      const deviceId = await p.deviceId()
      if (!uuid(deviceId)) return fail('closure_not_prepared')
      return snapshot(await request(r, 'prepare_device', { device_id: deviceId, native_generation: r.nativeGeneration }, c.auth))
    }),
    confirm: (handle, input: AccountClosureV2Confirmation) => exclusive(async () => {
      const r = await current(handle)
      if (!input || input.acknowledgeForfeit !== true || typeof input.code !== 'string' || !/^[0-9]{6,10}$/.test(input.code)) return fail('invalid_request')
      if (r.recoveryOnly || r.pendingEffect || r.phase !== 'prepared' || !r.serverPrepared || !r.serverGeneration || r.challengeGeneration < 1) return fail('closure_not_prepared')
      if (!r.serverRequest || r.serverRequest.id !== r.requestId || Date.parse(r.serverRequest.expiresAt) <= Date.now()) return fail('state_conflict')
      const c = await p.local.underAuth(async () => {
        await p.local.requireNativePreparation(localScope(r), r.nativeGeneration)
        return claim(r, 'confirm', value => { value.confirmationId = randomUUID(); value.confirmationGeneration = value.challengeGeneration; value.phase = 'confirming'; value.pendingConfirmCancellation = false; value.confirmCancellationBlocked = false })
      })
      return snapshot(await request(c.record, 'confirm', { consent_version: 'immediate-forfeit-v1', generation: c.record.confirmationGeneration!,
        confirmation_id: c.record.confirmationId!, native_generation: r.nativeGeneration, server_generation: r.serverGeneration,
        code: input.code, acknowledge_forfeit: true }, c.auth))
    }),
    recover: handle => exclusive(async () => {
      const r = await current(handle)
      if (r.phase === 'local-complete') return snapshot(r)
      if (r.serverState === 'deleted' || releaseProof(r)) return snapshot(await settle(r))
      return snapshot(await recoverRecord(r))
    }),
    cancel: handle => exclusive(async () => {
      let r = await current(handle)
      if (releaseProof(r)) return snapshot(await settle(r))
      const unknownConfirmation = r.pendingEffect === 'confirm'
      if (['processing', 'deleted', 'local-complete', 'finalized'].includes(r.phase)
        || unknownConfirmation && r.confirmCancellationBlocked
        || r.phase === 'confirming' && !unknownConfirmation) return fail('closure_recovery_required')
      if (unknownConfirmation) {
        if (!r.confirmationId || !r.confirmationGeneration || !r.serverGeneration || !r.localPreparationStarted) return fail('closure_not_prepared')
        // One original idempotent cancel per human command, never a loop. Keep
        // the original confirmation intent/nonce until the authority closes it.
        const c = await claim(r, 'confirm', value => { value.pendingConfirmCancellation = true })
        try {
          return snapshot(await request(c.record, 'cancel', { native_generation: r.nativeGeneration, server_generation: r.serverGeneration }, c.auth))
        } catch (error) {
          if (error instanceof ClosureV2HttpFailure && (error.status === 409 || error.code === 'request_active')) {
            await update(c.record, value => { value.confirmCancellationBlocked = true })
          }
          throw error
        }
      }
      if (r.recoveryOnly) {
        try { r = await recoverRecord(r) }
        catch (error) {
          // Explicit cancel may close a not-yet-registered original operation.
          // A 404 does not itself release the local seal.
          if (!(error instanceof ClosureV2HttpFailure) || error.code !== 'not_found') throw error
        }
        if (r.phase === 'cancelled') return snapshot(r)
        if (r.serverState && r.serverState !== 'open') return fail('closure_recovery_required')
        // If preparation never arrived, the authority may atomically close its
        // absence. A concurrently created preparation rejects this cancel until
        // original-result recovery supplies its server generation.
      }
      const c = await claim(r, 'cancel', value => { value.phase = 'cancel-pending' })
      const extra: Record<string, string | null> = { native_generation: r.nativeGeneration }
      if (r.serverGeneration) extra.server_generation = r.serverGeneration
      return snapshot(await request(c.record, 'cancel', extra, c.auth))
    }),
    finalize: handle => exclusive(async () => {
      let r = await current(handle)
      if (r.phase !== 'local-complete' || r.serverState !== 'deleted') return fail('closure_not_complete')
      await p.local.native.receipt.remove(localScope(r))
      r = await update(r, value => { value.phase = 'finalized'; value.receipt = null; value.pendingEffect = null; value.recoveryOnly = false })
      return snapshot(r)
    }),
  }
}
