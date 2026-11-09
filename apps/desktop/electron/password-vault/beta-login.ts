import { randomUUID } from 'node:crypto'
import { anySignal } from '@gugu/core/shared/anySignal'
import type { PasswordApproval, PasswordItem } from '@gugu/core/shared/passwordBetaProtocol'
import type { GuguMcpContext } from '../acp-engine-utils'
import { passwordNativeMcpIdentity } from '../mcp/password-native-identity'
import type { createBetaPasswordAccess } from '../permissions/password-beta-access'
import { browserWebContentsRegistry as browsers } from '../session/main/core/browser/browser-webcontents-registry'
import { credentialBindingMatches } from '../session/main/core/browser/credential-binding'
import { createCredentialExecution } from '../session/main/core/browser/credential-execution'
import { registerPrivateCredentialSurface } from '../session/main/core/browser/credential-isolation-registry'
import { prepareCredentialBrowserPartition } from '../session/main/core/browser/credential-browser-destination'
import { VaultBrowserLoginSurface } from '../session/main/core/browser/vault-browser-login-surface'
import type { VaultLoginSelection } from '../session/main/core/browser/vault-browser-login-protocol'
import type { CredentialUseBinding } from '../session/main/core/browser/credential-use-contract'
import type { UseOutcomeContext, PostUseAuditResult } from '../session/main/core/browser/credential-settlement-contract'
import type { LocalPasswordVault } from './service'
import type { VaultBrowserSink } from './contracts'
import { postPasswordRequest } from './beta-messages'

const unavailable = () => new Error('password_login_unavailable')
type Execution = ReturnType<typeof createCredentialExecution>
type Partition = Awaited<ReturnType<typeof prepareCredentialBrowserPartition>>
type Attempt = { binding: CredentialUseBinding; surface: VaultBrowserLoginSurface; execution: Execution;
  partition?: Partition; running?: Promise<void>; view: PasswordApproval; result: string;
  evidence?: UseOutcomeContext & { postUseAudit: PostUseAuditResult }; completed: boolean }
export interface BetaLoginHost {
  ownerId: string; deviceId: string; signal: AbortSignal
  access: ReturnType<typeof createBetaPasswordAccess>
  assertCurrent(): void
  changed(): void
  describe(agentId: string, sessionId: string): { agentName: string; sessionTitle: string }
  denied(): boolean
  deliver(sessionId: string, requestId: string, status: string): Promise<void>
}

/** The limited Beta path has its own presentation, never a fake full-B cleanup/custodian proof.
 * Approval, capability and single submission remain owned by the existing execution authority.
 */
export class BetaPasswordLogin {
  private readonly attempts = new Map<string, Attempt>()
  private preparing = false
  private vault?: LocalPasswordVault
  constructor(private readonly host: BetaLoginHost) {}
  bindVault(vault: LocalPasswordVault): void { if (this.vault) throw unavailable(); this.vault = vault }
  readonly sink: VaultBrowserSink = Object.freeze<VaultBrowserSink>({
    claimCredentialSink: (cap, binding) => this.require(binding).execution.authority.claimCredentialSink(cap, binding),
    fillAndSubmit: async (binding, secrets, control) => {
      const use = this.require(binding)
      await use.surface.fill(binding, control, secrets.account, secrets.password)
      await use.surface.submit(binding, control)
      // Wait for real navigation evidence. No website-supplied completion flag is trusted.
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        this.current(use)
        try {
          const proof = await use.surface.readCompletion(binding)
          if (proof.topDocumentChanged && proof.filledPasswordFieldsAbsent && !proof.requiresPersonInteraction) {
            use.completed = true
            return 'submitted_unconfirmed'
          }
        } catch { this.current(use) }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return 'person_interaction_required'
    },
    cleanup: async useId => {
      const use = [...this.attempts.values()].find(item => item.binding.useId === useId)
      if (use) await use.execution.authority.cleanup(useId)
      // This Beta path does not claim the postponed six-custodian full-B proof.
      return { status: 'isolated_login_retained' }
    },
    settle: async event => { this.require(event.binding).evidence = event },
  })
  pending(): PasswordApproval[] {
    return [...this.attempts.values()].filter(use => use.result === 'pending' && use.execution.status().status === 'pending').map(use => use.view)
  }
  status(requestId: string, sessionId: string): string {
    const use = this.attempts.get(requestId)
    if (!use || use.binding.sessionId !== sessionId) throw unavailable()
    return use.result
  }
  async request(context: GuguMcpContext, grant: AbortSignal, item: PasswordItem, input: {
    browserId: string; loginUrl: string; selection: VaultLoginSelection
  }): Promise<{ requestId: string; status: string }> {
    if (!this.vault || this.preparing || this.host.denied()
      || [...this.attempts.values()].some(use => ['pending', 'running'].includes(use.result))) throw unavailable()
    this.preparing = true
    let surface: VaultBrowserLoginSurface | undefined
    let registered: Attempt | undefined
    try {
      const identity = passwordNativeMcpIdentity(context)
      if (!identity || identity.ownerId !== this.host.ownerId) throw unavailable()
      const signal = anySignal([grant, this.host.signal])
      const assertCurrent = () => { signal.throwIfAborted(); this.host.assertCurrent(); if (this.host.denied()) throw unavailable() }
      assertCurrent()
      const source = browsers.browsersOfSession(identity.sessionId).find(page => page.browserId === input.browserId)?.webContents
      const partition = [...browsers.registeredPartitions].find(value => browsers.isRegisteredForSession(input.browserId, identity.sessionId, value))
      if (!source || !partition || new URL(input.loginUrl).origin !== item.origin) throw unavailable()
      const installation = await this.vault.prepareInstallationIdentity()
      assertCurrent(); installation.assertCurrent()
      if (installation.value.status !== 'persisted') throw unavailable()
      // eslint-disable-next-line prefer-const -- callbacks read these before the two preparation phases finish.
      let binding: CredentialUseBinding | undefined, attempt: Attempt | undefined
      const native = { context, sessionId: identity.sessionId, installationId: installation.value.installationId,
        deviceId: this.host.deviceId, signal, assertCurrent }
      // eslint-disable-next-line prefer-const -- the permission getter exists before the surface review produces its target.
      let target: Omit<CredentialUseBinding, 'requestId' | 'useId'> | undefined
      const port = await this.host.access.createPermission(native, () => binding ?? target!)
      assertCurrent()
      const execution = createCredentialExecution({
        current: () => { assertCurrent(); return true },
        isolationCurrent: current => { attempt?.partition?.isolation.assertCurrent(current); return !!attempt?.partition },
        verifyLocalDecision: (_current, evidence) => evidence === this,
        registerUse: () => { if (!attempt?.partition) throw unavailable() },
        cleanup: async () => {
          attempt?.partition?.isolation.beginCleanup()
          if (binding) await surface?.destroy(binding)
          return { status: 'isolated_login_retained' }
        },
        useCredential: this.vault.useCredential.bind(this.vault),
      }, port, signal)
      surface = new VaultBrowserLoginSurface({ browserId: input.browserId, partition, agentContents: source,
        permission: execution.permission, registerPrivateSurface: registerPrivateCredentialSurface,
        isolationReady: () => { try { if (!binding || !attempt?.partition) return false; attempt.partition.isolation.assertCurrent(binding); return true } catch { return false } },
        assertCurrent: () => { assertCurrent(); if (binding && attempt?.partition) attempt.partition.isolation.assertLifecycleCurrent(binding) },
      }, item.origin)
      await surface.load(input.loginUrl)
      const reviewed = await surface.review(input.selection)
      assertCurrent()
      target = { ...reviewed, accountId: identity.ownerId, installationId: installation.value.installationId,
        agentId: identity.subjectId, sessionId: identity.sessionId, browserId: input.browserId,
        credentialId: item.reference.id, credentialVersion: String(item.reference.version), lockEpoch: item.reference.epoch,
        operation: 'login-submit' }
      const presentation = this.host.describe(identity.subjectId, identity.sessionId)
      assertCurrent()
      const view = await execution.request(target, randomUUID())
      binding = Object.freeze({ ...target, requestId: view.requestId, useId: view.useId })
      attempt = { binding, execution, surface, completed: false, result: 'pending', view: {
        requestId: view.requestId, origin: item.origin, agent: identity.subjectId, ...presentation, sessionId: identity.sessionId,
        deviceId: this.host.deviceId, maskedAccount: item.maskedAccount, expiresAt: view.requestExpiresAt } }
      this.attempts.set(view.requestId, attempt)
      registered = attempt
      await postPasswordRequest(context, attempt.view)
      assertCurrent()
      const expired = setTimeout(() => {
        if (attempt?.execution.status().status === 'expired') {
          attempt.result = 'expired'; void this.retire(attempt).catch(() => {})
          void this.host.deliver(identity.sessionId, view.requestId, 'expired').catch(() => {})
          this.host.changed()
        }
      }, Math.max(1, view.requestExpiresAt - Date.now() + 1))
      expired.unref?.()
      signal.addEventListener('abort', () => { execution.cancel(); void this.retire(attempt!).catch(() => {}) }, { once: true })
      this.host.changed()
      return { requestId: view.requestId, status: 'pending' }
    } catch {
      // A notification may have committed before its response was lost. Its old card must never approve.
      if (registered) {
        try { registered.execution.cancel() } catch { /* Original authority may already be invalidated. */ }
        registered.result = 'cancelled'
        this.attempts.delete(registered.binding.requestId)
        this.host.changed()
      }
      await surface?.disposeUnused()
      throw unavailable()
    }
    finally { this.preparing = false }
  }
  decide(requestId: string, decision: 'allow_once' | 'reject'): void {
    const use = this.attempts.get(requestId)
    if (!use) throw unavailable()
    if (use.execution.status().status !== 'pending') throw unavailable()
    const view = use.execution.decide(decision, this)
    if (view.status === 'approved') {
      use.result = 'approved'
      const expiry = setTimeout(() => {
        if (use.execution.status().status === 'expired') {
          use.result = 'expired'; void this.retire(use).catch(() => {})
          void this.host.deliver(use.binding.sessionId, requestId, 'expired').catch(() => {})
          this.host.changed()
        }
      }, Math.max(1, (view.startBefore ?? Date.now()) - Date.now() + 1))
      expiry.unref?.()
    } else {
      use.result = view.status
      void use.surface.disposeUnused().catch(() => {})
    }
    void this.host.deliver(use.binding.sessionId, requestId, view.status).catch(() => {})
    this.host.changed()
  }
  async start(context: GuguMcpContext, requestId: string): Promise<{ status: string }> {
    const identity = passwordNativeMcpIdentity(context), use = this.attempts.get(requestId)
    if (!identity || !use || identity.sessionId !== use.binding.sessionId || identity.subjectId !== use.binding.agentId
      || identity.ownerId !== use.binding.accountId || use.execution.status().status !== 'approved') throw unavailable()
    use.running ??= this.run(use)
    await use.running
    return { status: use.result }
  }
  invalidate(): void {
    for (const use of this.attempts.values()) {
      use.execution.authority.invalidate(this.host.ownerId, 'lock')
      use.partition?.isolation.invalidate()
      void this.retire(use).catch(() => {})
      if (['pending', 'approved', 'running'].includes(use.result)) {
        use.result = 'invalidated'
        void this.host.deliver(use.binding.sessionId, use.binding.requestId, 'invalidated').catch(() => {})
      }
    }
    this.host.changed()
  }
  private require(binding: CredentialUseBinding): Attempt {
    const use = this.attempts.get(binding.requestId)
    if (!use || !credentialBindingMatches(use.binding, binding)) throw unavailable()
    return use
  }
  private current(use: Attempt): void { this.host.signal.throwIfAborted(); this.host.assertCurrent(); use.execution.permission.assertCurrent(use.binding) }
  private async retire(use: Attempt): Promise<void> {
    use.partition?.isolation.beginCleanup()
    if (!await use.surface.disposeUnused()) await use.surface.destroy(use.binding)
  }
  private async run(use: Attempt): Promise<void> {
    use.result = 'running'
    let candidate: Awaited<ReturnType<Partition['destination']['prepare']>> | undefined
    try {
      this.current(use)
      use.partition = await prepareCredentialBrowserPartition(use.binding)
      this.current(use)
      const result = await use.execution.use()
      this.current(use)
      const evidence = use.evidence
      if (result.status !== 'submitted_unconfirmed' || !use.completed || !evidence || evidence.postUseAudit.status !== 'recorded'
        || !this.vault?.outcomeAudit.matches(evidence.postUseAudit, evidence)) throw unavailable()
      await use.execution.permission.revalidate({ stage: 'before_handoff', target: use.binding })
      this.current(use)
      candidate = await use.partition.destination.prepare(use.binding)
      await candidate.loadOrigin(use.binding.origin)
      this.current(use)
      candidate.publish()
      this.current(use)
      candidate.confirm()
      use.result = 'submitted_unconfirmed'
    } catch {
      candidate?.retract()
      await candidate?.dispose().catch(() => {})
      await this.retire(use).catch(() => {})
      use.result = 'unavailable'
    } finally { this.host.changed() }
  }
}
