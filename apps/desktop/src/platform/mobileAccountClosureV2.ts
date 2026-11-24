import type {
  AccountClosureV2Confirmation, AccountClosureV2Handle, AccountClosureV2Native,
  AccountClosureV2Policy, AccountClosureV2Snapshot,
} from './accountClosureV2'

/** Native transport boundary shared by the two phone shells, with no legacy adapter. */
export interface MobileAccountClosureV2Bridge {
  readPolicy(): Promise<unknown>
  discover(): Promise<unknown>
  capture(): Promise<unknown>
  sendCode(input: { handle: AccountClosureV2Handle }): Promise<unknown>
  prepare(input: { handle: AccountClosureV2Handle }): Promise<unknown>
  confirm(input: { handle: AccountClosureV2Handle } & AccountClosureV2Confirmation): Promise<unknown>
  recover(input: { handle: AccountClosureV2Handle }): Promise<unknown>
  cancel(input: { handle: AccountClosureV2Handle }): Promise<unknown>
  finalizeOperation(input: { handle: AccountClosureV2Handle }): Promise<unknown>
}
const invalid = () => Object.assign(new Error('Invalid native account closure acknowledgement'), { code: 'closure_unavailable' })
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
const exact = (value: unknown, keys: readonly string[]) => {
  const result = object(value)
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) throw invalid()
  return result
}
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const phases = new Set(['captured', 'registered', 'challenge', 'local-prepared', 'prepared', 'confirming', 'processing',
  'deleted', 'local-complete', 'finalized', 'cancel-pending', 'cancelled'])
const serverStates = new Set(['open', 'confirming', 'processing', 'deleted', 'closed_before_confirm'])
const pendingEffects = new Set(['register', 'challenge', 'prepare_device', 'confirm', 'cancel'])
const androidRetained = ['auth-code-verifier', 'auth-oauth-pending', 'shared-incoming-file-cache',
  'shared-outgoing-file-cache', 'shared-runtime-temp-cache'] as const

function handle(value: unknown): AccountClosureV2Handle {
  const h = exact(value, ['localOperationId', 'nativeGeneration', 'localRevision'])
  if (typeof h.localOperationId !== 'string' || !h.localOperationId || new TextEncoder().encode(h.localOperationId).length > 256
    || !uuid(h.nativeGeneration) || !integer(h.localRevision) || h.localRevision < 1) throw invalid()
  return { localOperationId: h.localOperationId, nativeGeneration: h.nativeGeneration, localRevision: h.localRevision }
}
function policy(value: unknown): AccountClosureV2Policy {
  const p = exact(value, ['protocol_version', 'available', 'deletion', 'credit_treatment', 'consent_version', 'device_preparation_required'])
  if (p.protocol_version !== 2 || typeof p.available !== 'boolean' || p.deletion !== 'immediate'
    || p.credit_treatment !== 'forfeit_remaining' || p.consent_version !== 'immediate-forfeit-v1'
    || p.device_preparation_required !== true) throw invalid()
  return { protocol_version: 2, available: p.available, deletion: 'immediate', credit_treatment: 'forfeit_remaining',
    consent_version: 'immediate-forfeit-v1', device_preparation_required: true }
}

export function mobileAccountClosureV2(
  bridge: MobileAccountClosureV2Bridge, retainedNames: readonly string[] = androidRetained,
): AccountClosureV2Native {
  const retained = new Set(retainedNames)
  const snapshot = (value: unknown): AccountClosureV2Snapshot => {
    const hasBlocked = Object.hasOwn(object(value), 'confirmCancellationBlocked')
    const s = exact(value, ['handle', 'ownerId', 'phase', 'serverOperation', 'serverPreparationGeneration', 'recoveryOnly',
      'pendingEffect', 'agentsPaused', 'retainedUnattributed', ...(hasBlocked ? ['confirmCancellationBlocked'] : [])])
    if (!uuid(s.ownerId) || typeof s.phase !== 'string' || !phases.has(s.phase)
      || (s.serverPreparationGeneration !== null && !uuid(s.serverPreparationGeneration))
      || typeof s.recoveryOnly !== 'boolean' || typeof s.agentsPaused !== 'boolean'
      || (hasBlocked && typeof s.confirmCancellationBlocked !== 'boolean')
      || (s.pendingEffect !== null && (typeof s.pendingEffect !== 'string' || !pendingEffects.has(s.pendingEffect)))
      || !Array.isArray(s.retainedUnattributed) || !s.retainedUnattributed.every(name => typeof name === 'string' && retained.has(name))
      || new Set(s.retainedUnattributed).size !== s.retainedUnattributed.length) throw invalid()
    let serverOperation: AccountClosureV2Snapshot['serverOperation'] = null
    if (s.serverOperation !== null) {
      const rawOperation = object(s.serverOperation)
      const hasExpiry = Object.hasOwn(rawOperation, 'challengeExpiresAt')
      const operation = exact(rawOperation, ['operationId', 'state', 'operationRevision', 'challengeGeneration', ...(hasExpiry ? ['challengeExpiresAt'] : [])])
      if (!uuid(operation.operationId) || typeof operation.state !== 'string' || !serverStates.has(operation.state)
        || !integer(operation.operationRevision) || operation.operationRevision < 1 || !integer(operation.challengeGeneration)
        || operation.challengeGeneration > 2147483647
        || (hasExpiry && operation.challengeExpiresAt !== null && (typeof operation.challengeExpiresAt !== 'string'
          || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(operation.challengeExpiresAt)
          || !Number.isFinite(Date.parse(operation.challengeExpiresAt))))) throw invalid()
      serverOperation = { operationId: operation.operationId, state: operation.state as NonNullable<AccountClosureV2Snapshot['serverOperation']>['state'],
        operationRevision: operation.operationRevision, challengeGeneration: operation.challengeGeneration,
        ...(hasExpiry ? { challengeExpiresAt: operation.challengeExpiresAt as string | null } : {}) }
    }
    return { handle: handle(s.handle), ownerId: s.ownerId, phase: s.phase as AccountClosureV2Snapshot['phase'], serverOperation,
      serverPreparationGeneration: s.serverPreparationGeneration, recoveryOnly: s.recoveryOnly,
      pendingEffect: s.pendingEffect as AccountClosureV2Snapshot['pendingEffect'], agentsPaused: s.agentsPaused,
      ...(hasBlocked ? { confirmCancellationBlocked: s.confirmCancellationBlocked as boolean } : {}),
      retainedUnattributed: [...s.retainedUnattributed] as string[] }
  }
  return {
    readPolicy: async () => policy(await bridge.readPolicy()),
    async discover() {
      const result = exact(await bridge.discover(), ['snapshot'])
      return result.snapshot === null ? null : snapshot(result.snapshot)
    },
    capture: async () => snapshot(await bridge.capture()),
    sendCode: async h => snapshot(await bridge.sendCode({ handle: handle(h) })),
    prepare: async h => snapshot(await bridge.prepare({ handle: handle(h) })),
    async confirm(h, input) {
      const value = exact(input, ['code', 'acknowledgeForfeit'])
      if (typeof value.code !== 'string' || !/^[0-9]{6,10}$/.test(value.code) || value.acknowledgeForfeit !== true) throw invalid()
      return snapshot(await bridge.confirm({ handle: handle(h), code: value.code, acknowledgeForfeit: true }))
    },
    recover: async h => snapshot(await bridge.recover({ handle: handle(h) })),
    cancel: async h => snapshot(await bridge.cancel({ handle: handle(h) })),
    finalize: async h => snapshot(await bridge.finalizeOperation({ handle: handle(h) })),
  }
}
