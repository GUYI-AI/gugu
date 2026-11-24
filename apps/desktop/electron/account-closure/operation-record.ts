import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ClosureFailure } from './receipts'
import type { AccountClosureV2ServerState } from '../../src/platform/accountClosureV2'
import type { ClosureV2Operation } from './v2-http'

export type ClosureOperationPhase = 'captured' | 'registered' | 'challenge' | 'local-prepared' | 'prepared'
  | 'confirming' | 'processing' | 'deleted' | 'local-complete' | 'finalized' | 'cancel-pending' | 'cancelled'
export interface NativeClosureIdentity { ownerId: string; sessionId: string }
export interface ClosureOperationRecord {
  ownerId: string
  sessionId: string
  localOperationId: string
  nativeGeneration: string
  /** Private local eraser scope; never the public/wire operation ID. */
  cleanupScopeId: string
  receipt: string | null
  phase: ClosureOperationPhase
  revision: number
  serverOperationId: string | null
  serverGeneration: string | null
  serverRevision: number
  serverState: AccountClosureV2ServerState | null
  serverRequestState: string | null
  serverRequest: ClosureV2Operation['request']
  serverConfirmation: ClosureV2Operation['confirmation']
  canReleasePreparation: boolean | null
  serverPrepared: boolean
  serverCancelled: boolean
  pendingEffect: 'register' | 'challenge' | 'prepare_device' | 'confirm' | 'cancel' | null
  recoveryOnly: boolean
  localPreparationStarted: boolean
  pendingChallengeGeneration: number | null
  confirmationGeneration: number | null
  pendingConfirmCancellation?: boolean
  confirmCancellationBlocked?: boolean
  challengeGeneration: number
  requestId: string | null
  confirmationId: string | null
  retainedUnattributed: string[]
}
export type ClosureOperationMetadata = Pick<ClosureOperationRecord,
  'ownerId' | 'localOperationId' | 'nativeGeneration' | 'phase' | 'revision' | 'serverOperationId'
  | 'serverGeneration' | 'serverRevision' | 'challengeGeneration' | 'requestId' | 'confirmationId' | 'retainedUnattributed'>
interface Envelope { version: 2; binding: string; activeOwner: string | null; records: Record<string, ClosureOperationRecord> }
interface Ports {
  /** Existing system-encrypted store; one replacement contains discovery and capability. */
  secrets: { getSecret(key: string): Promise<string | null>; setSecret(key: string, value: string): Promise<void> }
  profileBinding: string
  identity(): Promise<NativeClosureIdentity | null | undefined>
  underAuth<T>(work: () => Promise<T>): Promise<T>
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const phases = new Set<ClosureOperationPhase>(['captured', 'registered', 'challenge', 'local-prepared', 'prepared',
  'confirming', 'processing', 'deleted', 'local-complete', 'finalized', 'cancel-pending', 'cancelled'])
const terminal = (record: ClosureOperationRecord) => record.phase === 'finalized' || record.phase === 'cancelled'
const fail = (code: 'closure_storage_unavailable' | 'wrong_local_owner' | 'scope_conflict' | 'closure_context_missing'): never => { throw new ClosureFailure(code) }
// A positive list also excludes future/unknown protected fields after loading.
const metadata = (r: ClosureOperationRecord): ClosureOperationMetadata => structuredClone({
  ownerId: r.ownerId, localOperationId: r.localOperationId, nativeGeneration: r.nativeGeneration,
  phase: r.phase, revision: r.revision, serverOperationId: r.serverOperationId,
  serverGeneration: r.serverGeneration, serverRevision: r.serverRevision, challengeGeneration: r.challengeGeneration,
  requestId: r.requestId, confirmationId: r.confirmationId, retainedUnattributed: r.retainedUnattributed,
})
function valid(value: unknown): value is ClosureOperationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as ClosureOperationRecord
  return [r.ownerId, r.sessionId, r.localOperationId, r.nativeGeneration, r.cleanupScopeId].every(v => typeof v === 'string' && uuid.test(v))
    && phases.has(r.phase) && Number.isSafeInteger(r.revision) && r.revision > 0
    && Number.isSafeInteger(r.serverRevision) && r.serverRevision >= 0
    && (r.serverState === null || ['open', 'confirming', 'processing', 'deleted', 'closed_before_confirm'].includes(r.serverState))
    && (r.serverRequestState === null || ['sending', 'challenge', 'verifying', 'processing', 'retry_wait', 'deleted', 'failed', 'expired'].includes(r.serverRequestState))
    && (r.serverRequest === null || !!r.serverRequest && uuid.test(r.serverRequest.id)
      && ['sending', 'challenge', 'verifying', 'processing', 'retry_wait', 'deleted', 'failed', 'expired'].includes(r.serverRequest.state) && typeof r.serverRequest.expiresAt === 'string' && Number.isFinite(Date.parse(r.serverRequest.expiresAt))
      && (r.serverRequest.lastError === null || typeof r.serverRequest.lastError === 'string' && r.serverRequest.lastError.length <= 64)
      && typeof r.serverRequest.canRetry === 'boolean')
    && (r.canReleasePreparation === null || typeof r.canReleasePreparation === 'boolean')
    && typeof r.serverPrepared === 'boolean' && typeof r.serverCancelled === 'boolean' && typeof r.recoveryOnly === 'boolean' && typeof r.localPreparationStarted === 'boolean'
    && [r.pendingConfirmCancellation, r.confirmCancellationBlocked].every(v => v === undefined || typeof v === 'boolean')
    && (r.pendingEffect === null || ['register', 'challenge', 'prepare_device', 'confirm', 'cancel'].includes(r.pendingEffect))
    && [r.pendingChallengeGeneration, r.confirmationGeneration].every(v => v === null || Number.isInteger(v) && v > 0 && v <= 2147483647)
    && (r.serverConfirmation === null || !!r.serverConfirmation && uuid.test(r.serverConfirmation.id) && ['verifying', 'rejected', 'processing', 'deleted'].includes(r.serverConfirmation.state)
      && Number.isInteger(r.serverConfirmation.challengeGeneration) && r.serverConfirmation.challengeGeneration > 0
      && (r.serverConfirmation.errorCode === null || typeof r.serverConfirmation.errorCode === 'string' && r.serverConfirmation.errorCode.length <= 64))
    && Number.isInteger(r.challengeGeneration) && r.challengeGeneration >= 0 && r.challengeGeneration <= 2147483647
    && [r.serverOperationId, r.serverGeneration, r.requestId, r.confirmationId].every(v => v === null || (typeof v === 'string' && uuid.test(v)))
    && (terminal(r) ? r.receipt === null : typeof r.receipt === 'string' && /^[a-f0-9]{64}$/.test(r.receipt))
    && Array.isArray(r.retainedUnattributed) && r.retainedUnattributed.every(v => typeof v === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(v))
}

/** Native-only V2 custody. Its metadata and secret are atomic, so an ordinary
 * browser journal is neither discovery authority nor a prerequisite to recover.
 * No method accepts a renderer-supplied terminal state or server proof.
 */
export function createClosureOperationRecords(ports: Ports) {
  const binding = createHash('sha256').update(ports.profileBinding).digest('hex')
  const key = `account-closure-operations-v2:${binding}`
  async function read(): Promise<Envelope> {
    const raw = await ports.secrets.getSecret(key)
    if (raw === null) return { version: 2, binding, activeOwner: null, records: {} }
    try {
      if (Buffer.byteLength(raw, 'utf8') > 1_048_576) return fail('closure_storage_unavailable')
      const data = JSON.parse(raw) as Envelope
      if (data.version !== 2 || data.binding !== binding || !data.records || typeof data.records !== 'object' || Array.isArray(data.records)
          || (data.activeOwner !== null && (!uuid.test(data.activeOwner) || !Object.hasOwn(data.records, data.activeOwner)))) return fail('closure_storage_unavailable')
      for (const [owner, record] of Object.entries(data.records)) if (!uuid.test(owner) || !valid(record) || record.ownerId !== owner) return fail('closure_storage_unavailable')
      return data
    } catch { return fail('closure_storage_unavailable') }
  }
  async function write(data: Envelope) {
    const raw = JSON.stringify(data)
    if (Buffer.byteLength(raw, 'utf8') > 1_048_576) return fail('closure_storage_unavailable')
    await ports.secrets.setSecret(key, raw)
  }
  async function identity(): Promise<NativeClosureIdentity | null> {
    const current = await ports.identity()
    if (current === undefined) return fail('closure_storage_unavailable')
    if (current && (!uuid.test(current.ownerId) || !uuid.test(current.sessionId))) return fail('closure_storage_unavailable')
    return current
  }
  async function own(record: ClosureOperationRecord, requireSession: boolean) {
    const current = await identity()
    if (current && current.ownerId !== record.ownerId) return fail('wrong_local_owner')
    if (requireSession && (!current || current.sessionId !== record.sessionId)) return fail('scope_conflict')
  }
  const guarded = <T>(work: () => Promise<T>) => ports.underAuth(async () => {
    try { return await work() }
    catch (error) { throw error instanceof ClosureFailure ? error : new ClosureFailure('closure_storage_unavailable') }
  })
  return {
    begin: () => guarded(async (): Promise<ClosureOperationMetadata> => {
      const current = await identity()
      if (!current) return fail('wrong_local_owner')
      const data = await read(), existing = data.records[current.ownerId]
      if (existing && !terminal(existing)) { await own(existing, true); return metadata(existing) }
      const record: ClosureOperationRecord = {
        ...current, localOperationId: randomUUID(), nativeGeneration: randomUUID(), cleanupScopeId: randomUUID(), receipt: randomBytes(32).toString('hex'),
        phase: 'captured', revision: 1, serverOperationId: null, serverGeneration: null, serverRevision: 0,
        serverState: null, serverRequestState: null, serverRequest: null, serverConfirmation: null, canReleasePreparation: null,
        serverPrepared: false, serverCancelled: false, pendingEffect: null, recoveryOnly: false, localPreparationStarted: false,
        pendingChallengeGeneration: null, confirmationGeneration: null, pendingConfirmCancellation: false, confirmCancellationBlocked: false,
        challengeGeneration: 0, requestId: null, confirmationId: null, retainedUnattributed: [],
      }
      await own(record, true)
      data.records[current.ownerId] = record
      data.activeOwner = current.ownerId
      await write(data)
      return metadata(record)
    }),
    discover: () => guarded(async (): Promise<ClosureOperationMetadata | null> => {
      const current = await identity(), data = await read()
      const owner = current?.ownerId ?? data.activeOwner
      const preferred = owner && data.records[owner]
      // Signed-out recovery must not lose A when a later B operation is already
      // terminal. A currently signed-in B still sees only B's own record.
      const record = preferred && !terminal(preferred) ? preferred : current ? null
        : Object.values(data.records).find(item => !terminal(item)) ?? null
      if (!record || terminal(record)) return null
      await own(record, false)
      return metadata(record)
    }),
    /** Native explicit-resume admission needs the current owner's terminal
     * record too. It never selects another signed-out recovery owner. */
    currentNative: () => guarded(async () => {
      const current = await identity()
      if (!current) return fail('wrong_local_owner')
      const record = (await read()).records[current.ownerId]
      return record ? structuredClone(record) : null
    }),
    /** Only the native transport/eraser imports these methods. None is an IPC command. */
    readNative: (scope: Pick<ClosureOperationRecord, 'ownerId' | 'localOperationId'>, requireSession = false) => guarded(async () => {
      const record = (await read()).records[scope.ownerId]
      if (!record) return fail('closure_context_missing')
      if (record.localOperationId !== scope.localOperationId) return fail('scope_conflict')
      await own(record, requireSession)
      return structuredClone(record)
    }),
    updateNative: (captured: ClosureOperationRecord, change: (record: ClosureOperationRecord) => void) => guarded(async () => {
      const data = await read(), record = data.records[captured.ownerId]
      if (!record || record.localOperationId !== captured.localOperationId || record.nativeGeneration !== captured.nativeGeneration
          || record.revision !== captured.revision) return fail('scope_conflict')
      await own(record, false)
      const immutable = JSON.stringify([record.ownerId, record.sessionId, record.localOperationId, record.nativeGeneration, record.cleanupScopeId])
      change(record)
      record.revision += 1
      if (!valid(record) || immutable !== JSON.stringify([record.ownerId, record.sessionId, record.localOperationId, record.nativeGeneration, record.cleanupScopeId])) return fail('scope_conflict')
      // Another account's record survives this one account's checkpoint.
      await write(data)
      return structuredClone(record)
    }),
    metadata,
  }
}
