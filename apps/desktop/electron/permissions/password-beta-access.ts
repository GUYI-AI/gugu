import type { GuguMcpContext } from '../acp-engine-utils'
import { anySignal } from '@gugu/core/shared/anySignal'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import type { CredentialUseBinding } from '../session/main/core/browser/credential-use-contract'
import { canonicalJson } from './operation'
import { PasswordFactWindow, PasswordPermissionError, passwordUnavailable } from './password-facts'
import type { PasswordPermissionCheck, PasswordPermissionGuard, PasswordPermissionPort, PasswordPermissionTarget } from './password-execution'
import { decidePasswordUsePermission, type PasswordPermissionCaller } from './password-policy'
import type { PasswordAvailability } from './password-readiness'
import { parsePermissionPolicy, type PermissionPolicy } from './rules'

/** Native grant metadata only. Never construct it from a tool binding or by parsing grantKey. */
export interface BetaPasswordContext {
  readonly context: GuguMcpContext
  readonly sessionId: string
  readonly installationId: string
  readonly deviceId: string
  readonly signal: AbortSignal
  assertCurrent(): void
}
export interface BetaPasswordHost {
  /** Actual account/app lifetime, supplied by the fixed native constructor. */
  readonly signal: AbortSignal
  /** Reuses the existing native tool-scope derivation. */
  toolScope(context: GuguMcpContext): string
  /** Bound to ServicePermissionPolicyStore.read; no cached policy or approval input. */
  readPolicy(ownerId: string, signal: AbortSignal): Promise<PermissionPolicy>
}
type Target = PasswordPermissionTarget | CredentialUseBinding
const fields = { requestId: true, useId: true, accountId: true, installationId: true, agentId: true, sessionId: true,
  browserId: true, loginSurfaceId: true, loginSurfaceEpoch: true, documentId: true, frameId: true, formFingerprint: true,
  credentialId: true, credentialVersion: true, lockEpoch: true, origin: true, operation: true } satisfies Record<keyof CredentialUseBinding, true>
const bindingKeys = Object.keys(fields) as (keyof CredentialUseBinding)[]
const present = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
function synchronous<T>(result: T): T {
  if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
    void Promise.resolve(result).catch(() => {})
    throw passwordUnavailable()
  }
  return result
}

/**
 * Build-channel Beta exception. It does not certify the seven production protections or
 * enable the full PasswordFeatureReadiness path. It never approves, issues a capability or claims
 * submission: the existing native approval authority must still require one person decision/use.
 */
export function createBetaPasswordAccess(host: Partial<BetaPasswordHost> = {}) {
  const lifetime = host.signal
  const scope = host.toolScope?.bind(host), policy = host.readPolicy?.bind(host)
  const windowFor = (signal: AbortSignal, nativeSignal?: AbortSignal) => {
    const window = new PasswordFactWindow(anySignal([signal, lifetime, nativeSignal]))
    try {
      if (!PASSWORD_BETA_ENABLED || !(lifetime instanceof AbortSignal)) throw passwordUnavailable()
      // Capture the real lifetime without manufacturing a ready fact or generation.
      window.bind(() => {
        lifetime.throwIfAborted()
      })
      window.assertCurrent()
      return window
    } catch { window.fail(); throw passwordUnavailable() }
  }
  return Object.freeze({
    async acquireFeatureGuard(operation: 'save' | 'use', signal: AbortSignal): Promise<PasswordAvailability> {
      try {
        if (operation !== 'save' && operation !== 'use') throw passwordUnavailable()
        const window = windowFor(signal)
        return Object.freeze({ status: 'ready', signal: window.signal, assertCurrent: window.assertCurrent })
      } catch { return Object.freeze({ status: 'unavailable', reason: 'password_permission_unavailable' }) }
    },
    async createPermission(native: BetaPasswordContext, target: () => Target): Promise<PasswordPermissionPort> {
      const getTarget = target
      return Object.freeze({
        async revalidate(input: PasswordPermissionCheck, signal: AbortSignal): Promise<PasswordPermissionGuard> {
          let window: PasswordFactWindow | undefined
          try {
            if (!scope || !policy || !native || !native.context || typeof native.assertCurrent !== 'function'
              || !(native.signal instanceof AbortSignal) || typeof getTarget !== 'function') throw passwordUnavailable()
            window = windowFor(signal, native.signal)
            const context = native.context, revoked = native.signal, verify = native.assertCurrent.bind(native)
            const actor = (): PasswordPermissionCaller => ({ ownerId: native.context.expectedOwnerUserId,
              subjectId: native.context.subjectId, sessionId: native.sessionId, installationId: native.installationId,
              deviceId: native.deviceId, toolScope: synchronous(scope(native.context)) })
            const caller = Object.freeze(actor()), encodedActor = canonicalJson(caller)
            if (Object.values(caller).some(value => !present(value))) throw passwordUnavailable()
            window.bind(() => {
              revoked.throwIfAborted()
              if (synchronous(verify()) !== undefined || native.signal !== revoked || native.context !== context
                || canonicalJson(actor()) !== encodedActor) throw passwordUnavailable()
            })
            if (!input || !['request', 'before_fill', 'before_submit', 'before_handoff'].includes(input.stage)) throw passwordUnavailable()
            const stage = input.stage, original = input.target, request = stage === 'request'
            const keys = request ? bindingKeys.filter(key => key !== 'requestId' && key !== 'useId') : bindingKeys
            if (!original || keys.some(key => !present((original as CredentialUseBinding)[key]))
              || original.operation !== 'login-submit' || request && ('requestId' in original || 'useId' in original)
              || !request && (original as CredentialUseBinding).requestId === (original as CredentialUseBinding).useId) throw passwordUnavailable()
            const origin = new URL(original.origin)
            if (origin.protocol !== 'https:' || origin.origin !== original.origin) throw passwordUnavailable()
            const snapshot = Object.freeze({ ...original }), encodedTarget = canonicalJson(snapshot)
            if (snapshot.accountId !== caller.ownerId || snapshot.agentId !== caller.subjectId
              || snapshot.sessionId !== caller.sessionId || snapshot.installationId !== caller.installationId) throw passwordUnavailable()
            window.bind(() => {
              // The authority allocates IDs after the request gate. That legitimate transition
              // preserves the request target; all later guards still pin the complete binding.
              const currentTarget = synchronous(getTarget())
              const liveTarget = request ? Object.fromEntries(Object.entries(currentTarget)
                .filter(([key]) => key !== 'requestId' && key !== 'useId')) : currentTarget
              if (input.stage !== stage || input.target !== original || canonicalJson(input.target) !== encodedTarget
                || canonicalJson(liveTarget) !== encodedTarget) throw passwordUnavailable()
            })
            const parsed = parsePermissionPolicy(await window.read(s => policy(caller.ownerId, s)))
            const decision = decidePasswordUsePermission({ caller, policy: parsed, resource: {
              ownerId: caller.ownerId, agentOwnerId: caller.ownerId, agentId: caller.subjectId,
              sessionId: caller.sessionId, installationId: caller.installationId, deviceId: caller.deviceId, toolScope: caller.toolScope,
            } })
            if (decision.effect === 'deny') throw new PasswordPermissionError('password_permission_denied')
            if (decision.effect !== 'ask') throw passwordUnavailable()
            window.assertCurrent()
            return Object.freeze({ signal: window.signal, requiresPersonConfirmation: true, assertCurrent: window.assertCurrent })
          } catch (error) {
            window?.fail()
            throw new PasswordPermissionError(error instanceof PasswordPermissionError && error.code === 'password_permission_denied'
              ? 'password_permission_denied' : 'password_permission_unavailable')
          }
        },
      })
    },
  })
}
