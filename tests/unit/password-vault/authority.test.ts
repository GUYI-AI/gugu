import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { createVaultStorage } from '../../../apps/desktop/electron/password-vault/host'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import type { VaultDependencies, VaultSinkControl, VaultUseBinding } from '../../../apps/desktop/electron/password-vault/contracts'
import { CredentialApprovalState } from '../../../apps/desktop/electron/session/main/core/browser/credential-approval-state'
import { CredentialUseAuthorityBridge } from '../../../apps/desktop/electron/session/main/core/browser/credential-use-authority'
import type { CredentialUseSettlement } from '../../../apps/desktop/electron/session/main/core/browser/credential-settlement-contract'
const LOGIN = { values: [{ kind: 'account' }, { kind: 'password' }], elsewhere: false } as const


vi.mock('@gugu/core/shared/passwordBeta', () => ({ PASSWORD_BETA_ENABLED: true }))

const vaults: LocalPasswordVault[] = [], roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const vault of vaults.splice(0)) await vault.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function scenario() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-authority-canary-')); roots.push(root)
  const person = {}, actor = {}, wrappingKey = randomBytes(32), readiness = new AbortController()
  const state = { modeReady: true, deliveries: 0, submissions: 0 }
  const approval = new CredentialApprovalState({ current: () => true, verifyLocalDecision: (_binding, evidence) => evidence === person })
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }))
  const register = vi.fn((_capability: object, _binding: VaultUseBinding, _revoked: AbortSignal): void => {})
  const authority = new CredentialUseAuthorityBridge({ approval, isolationCurrent: () => true, cleanup, registerUse: register })
  let fillSignal: AbortSignal | undefined, fillRevoked: AbortSignal | undefined
  const fill = vi.fn(async (_binding: VaultUseBinding, _secrets: { values: readonly Buffer[] }, control: VaultSinkControl) => {
    fillRevoked = control.revokedSignal
    state.deliveries++; await control.prepareSubmission(); control.claimSubmission(); state.submissions++
    return 'submitted_unconfirmed' as const
  })
  const settle = vi.fn(async (_event: CredentialUseSettlement) => undefined)
  const dependencies: VaultDependencies = {
    root: join(root, 'private', 'password-vault', 'v1'), accountId: randomUUID(), installationBinding: randomUUID(),
    assertLocalPerson(value) { if (value !== person) throw new Error('synthetic person rejected') },
    assertOwnedLocalAgent(value) { if (value !== actor) throw new Error('synthetic actor rejected') },
    assertPrivateStorageReady: async () => undefined,
    acquireFeatureGuard: async () => ({ status: 'ready', signal: readiness.signal,
      assertCurrent() { if (!state.modeReady) throw new Error('synthetic disabled fact') } }),
    keys: { verifyPerson: async () => undefined, wrap: async (key, binding) => JSON.stringify(seal(wrappingKey, key, binding)),
      unwrap: async (key, binding) => unseal(wrappingKey, JSON.parse(key), binding) },
    invalidate: async event => authority.invalidate(dependencies.accountId, event.reason === 'edit' ? 'edit' : 'lock', event.credentialId),
    browser: { claimCredentialSink(capability, binding) {
      const lease = authority.claimCredentialSink(capability, binding); fillSignal = lease.signal; return lease
    }, fillAndSubmit: fill, cleanup: useId => authority.cleanup(useId), settle },
  }
  const { browser, acquireFeatureGuard, ...host } = dependencies
  const ports = createVaultStorage(host, browser!, acquireFeatureGuard!), vault = ports.vault; vaults.push(vault)
  await vault.list(person)
  const saved = await vault.save(person, randomUUID(), { origin: 'https://login.example.test', account: randomUUID(), password: randomBytes(32).toString('base64url') })
  const checked = await vault.checkReference(actor, saved.reference)
  if (checked.status !== 'valid') throw new Error('synthetic fixture unavailable')
  const target = { accountId: dependencies.accountId, installationId: checked.installationId, agentId: randomUUID(), sessionId: randomUUID(), browserId: randomUUID(),
    loginSurfaceId: randomUUID(), loginSurfaceEpoch: randomUUID(), documentId: randomUUID(), frameId: randomUUID(), formFingerprint: 'synthetic-form',
    credentialId: saved.reference.id, credentialVersion: String(saved.reference.version), lockEpoch: saved.reference.epoch, origin: saved.origin, operation: 'login-submit' as const }
  const request = approval.request(target, randomUUID()), binding = { ...target, requestId: request.requestId, useId: request.useId }
  approval.decide(request.requestId, 'allow_once', person)
  const capability = authority.issue(request.requestId, binding)
  return { vault, ports, approval, authority, state, readiness, cleanup, fill, settle, binding, capability,
    fillSignal: () => fillSignal, fillRevoked: () => fillRevoked, revokedSignal: register.mock.calls[0]![2] }
}

describe('vault with the real credential approval and use authority', () => {
  it('completes normal cleanup after stopping the fill lease without revoking approval', async () => {
    const f = await scenario(), result = await f.vault.useCredential(f.capability, f.binding, LOGIN)
    expect(f.ports.outcomeAudit).toBe(f.vault.outcomeAudit)
    expect(f.fillSignal()?.aborted).toBe(true); expect(f.revokedSignal.aborted).toBe(false)
    expect(f.fillRevoked()).toBe(f.revokedSignal)
    expect(f.approval.status(f.binding.requestId).status).toBe('submission_claimed')
    expect(f.state.submissions).toBe(1); expect(f.cleanup).toHaveBeenCalledOnce()
    expect(result).toEqual({ status: 'submitted_unconfirmed', retry: false, retainIsolatedLogin: false })
    const settled = f.settle.mock.calls[0]![0]
    expect(settled.postUseAudit.status).toBe('recorded')
    expect(settled.postUseAudit.status === 'recorded' && f.vault.outcomeAudit.matches(settled.postUseAudit, settled)).toBe(true)
  })
  it.each(['readiness', 'approval'] as const)('clears delivered buffers and blocks submission on genuine %s revocation', async source => {
    const f = await scenario(), entered = deferred(), release = deferred()
    let secret: { values: readonly Buffer[] } | undefined
    f.fill.mockImplementationOnce(async (_binding, secrets, control) => {
      f.state.deliveries++; secret = secrets; await control.prepareSubmission(); entered.resolve(); await release.promise
      control.claimSubmission(); f.state.submissions++; return 'submitted_unconfirmed'
    })
    const pending = f.vault.useCredential(f.capability, f.binding, LOGIN)
    await entered.promise
    const hadPlaintext = !!secret?.values[1]!.some(byte => byte !== 0)
    if (source === 'readiness') f.readiness.abort()
    else f.approval.cancel(f.binding.requestId, f.binding)
    const clearedSynchronously = !!secret && [...secret.values].every(value => value.every(byte => byte === 0))
    release.resolve(); const result = await pending
    expect(hadPlaintext).toBe(true); expect(clearedSynchronously).toBe(true)
    expect(f.state.submissions).toBe(0); expect(result.status).toBe('uncertain'); expect(result.retainIsolatedLogin).toBe(true)
  })
  it.each(['readiness', 'approval', 'disabled'] as const)('keeps a genuine %s failure latched while normal cleanup is awaiting', async source => {
    const f = await scenario(), entered = deferred(), release = deferred()
    f.cleanup.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { status: 'cleaned' } })
    const pending = f.vault.useCredential(f.capability, f.binding, LOGIN)
    await entered.promise
    const fillAlreadyStopped = f.fillSignal()?.aborted, approvalWasCurrent = !f.revokedSignal.aborted
    if (source === 'readiness') f.readiness.abort()
    else if (source === 'approval') f.approval.cancel(f.binding.requestId, f.binding)
    else f.state.modeReady = false
    release.resolve(); const result = await pending
    expect(fillAlreadyStopped).toBe(true); expect(approvalWasCurrent).toBe(true)
    expect(f.state.submissions).toBe(1); expect(result.status).toBe('uncertain'); expect(result.retainIsolatedLogin).toBe(true)
    const settled = f.settle.mock.calls[0]![0]
    expect(settled.outcome).toBe('uncertain')
  })
})
