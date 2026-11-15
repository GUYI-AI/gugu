import { randomUUID } from 'node:crypto'
import type { AuditInput, AuditReceipt, VaultUseBinding, VaultUseCapability } from './contracts'
import type { FixedOutcomeAuditPort, PostUseAuditProof, PostUseAuditResult, RecordedPostUseAudit, UseOutcomeContext } from '../session/main/core/browser/credential-settlement-contract'

const outcomes = new Set(['unavailable', 'submitted_unconfirmed', 'login_confirmed', 'person_interaction_required', 'failed', 'uncertain', 'filled'])
const sameBinding = (left: VaultUseBinding, right: VaultUseBinding) => {
  const keys = Object.keys(left) as (keyof VaultUseBinding)[]
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key])
}
const sameContext = (left: UseOutcomeContext, right: UseOutcomeContext) => left.capability === right.capability
  && left.outcome === right.outcome && left.effectPossible === right.effectPossible && sameBinding(left.binding, right.binding)

/** Audit evidence only. Approval, cleanup and handback authority remain with the browser coordinator. */
export class OutcomeAuditIssuer {
  #bindings = new WeakMap<VaultUseCapability, VaultUseBinding>()
  #proofs = new WeakMap<PostUseAuditProof, { context: UseOutcomeContext; eventId: string; recordId: string }>()
  readonly port: FixedOutcomeAuditPort
  constructor(private readonly write: (event: AuditInput, effectPossible: boolean) => Promise<AuditReceipt>,
    private readonly assertCurrent: (binding: VaultUseBinding) => void) {
    this.port = Object.freeze({ appendOutcome: (context: UseOutcomeContext) => this.append(context),
      matches: (receipt: RecordedPostUseAudit, expected: UseOutcomeContext) => this.matches(receipt, expected) })
  }
  /** Called only after the fixed sink atomically claimed the original process-local capability. */
  register(capability: VaultUseCapability, binding: VaultUseBinding): void {
    if (this.#bindings.has(capability)) throw new Error('duplicate_outcome_context')
    this.#bindings.set(capability, Object.freeze({ ...binding }))
  }
  clear(): void { this.#bindings = new WeakMap(); this.#proofs = new WeakMap() }
  private current(context: UseOutcomeContext): boolean {
    const registered = this.#bindings.get(context.capability)
    if (!registered || !outcomes.has(context.outcome) || typeof context.effectPossible !== 'boolean' || !sameBinding(registered, context.binding)) return false
    this.assertCurrent(context.binding)
    return true
  }
  private async append(input: UseOutcomeContext): Promise<PostUseAuditResult> {
    const context = Object.freeze({ capability: input.capability, binding: Object.freeze({ ...input.binding }),
      outcome: input.outcome, effectPossible: input.effectPossible })
    const failure = (): PostUseAuditResult => ({ status: context.effectPossible ? 'uncertain' : 'unavailable' })
    try {
      if (!this.current(context)) return failure()
      const bound = context.binding, eventId = randomUUID()
      const event: AuditInput = { id: eventId, action: 'use', source: 'browser', // The audit log already knows a fill that is done as completed.
        outcome: context.outcome === 'unavailable' ? 'failed' : context.outcome === 'filled' ? 'completed' : context.outcome,
        agentId: bound.agentId, sessionId: bound.sessionId, requestId: bound.requestId, useId: bound.useId, loginSurfaceId: bound.loginSurfaceId,
        origin: bound.origin, ...(bound.credentialId.startsWith('typed:') ? {} : { credential: { id: bound.credentialId, version: Number(bound.credentialVersion) } }) }
      const receipt = await this.write(event, context.effectPossible)
      if (receipt.status !== 'recorded' || receipt.recordId !== eventId || !this.current(context)) return failure()
      const proof = Object.freeze({}) as PostUseAuditProof
      this.#proofs.set(proof, { context, eventId, recordId: receipt.recordId })
      return Object.freeze({ status: 'recorded', eventId, recordId: receipt.recordId, proof })
    } catch { return failure() }
  }
  private matches(receipt: RecordedPostUseAudit, expected: UseOutcomeContext): boolean {
    try {
      if (receipt.status !== 'recorded') return false
      const issued = this.#proofs.get(receipt.proof)
      return !!issued && receipt.eventId === issued.eventId && receipt.recordId === issued.recordId
        && sameContext(issued.context, expected) && this.current(expected)
    } catch { return false }
  }
}
