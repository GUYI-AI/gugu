import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { VaultDisk } from '../../../apps/desktop/electron/password-vault/disk'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import { VaultError, type VaultDependencies, type VaultUseBinding, type VaultUseCapability, type VaultUseControl, type VaultSinkControl } from '../../../apps/desktop/electron/password-vault/contracts'
import { totpCode } from '../../../apps/desktop/electron/password-vault/totp'
import type { CredentialUseSettlement } from '../../../apps/desktop/electron/session/main/core/browser/credential-settlement-contract'
const LOGIN = { values: [{ kind: 'account' }, { kind: 'password' }], elsewhere: false } as const


const disposals: LocalPasswordVault[] = [], roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const vault of disposals.splice(0)) await vault.dispose().catch(() => undefined); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function scenario(withSettlement = true) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-sink-canary-')); roots.push(root)
  const owner = randomUUID(), person = {}, actor = {}, key = randomBytes(32), issued = new WeakMap<object, { binding: VaultUseBinding; claimed: boolean; submitted: boolean; abort: AbortController }>()
  const controllers: AbortController[] = []
  const fill = vi.fn(async (_binding: VaultUseBinding, _secrets: { values: readonly Buffer[] }, control: VaultSinkControl) => { control.assertCurrent(); await control.prepareSubmission(); control.claimSubmission(); return 'submitted_unconfirmed' as const })
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }))
  const settle = vi.fn(async (_event: CredentialUseSettlement) => undefined)
  const dependencies: VaultDependencies = { root: join(root, 'private', 'password-vault', 'v1'), accountId: owner, installationBinding: randomUUID(),
    assertLocalPerson: context => { if (context !== person) throw new Error() }, assertOwnedLocalAgent: context => { if (context !== actor) throw new Error() },
    assertPrivateStorageReady: vi.fn(async () => undefined), acquireFeatureGuard: vi.fn(async () => ({ status: 'ready' as const, signal: new AbortController().signal, assertCurrent() {} })),
    keys: { verifyPerson: async () => undefined, wrap: async (value, binding) => JSON.stringify(seal(key, value, binding)), unwrap: async (value, binding) => unseal(key, JSON.parse(value), binding) },
    invalidate: vi.fn(async () => { for (const controller of controllers) controller.abort() }),
    browser: { fillAndSubmit: fill, cleanup, settle: withSettlement ? settle : undefined as never,
      claimCredentialSink(capability, binding) {
        const use = issued.get(capability)
        if (!use || use.claimed || JSON.stringify(use.binding) !== JSON.stringify(binding)) throw new VaultError('UNAVAILABLE')
        use.claimed = true
        return { signal: use.abort.signal, revokedSignal: use.abort.signal, assertCurrent: () => { if (use.abort.signal.aborted) throw new VaultError('CANCELLED') },
          claimSubmission: () => { if (use.submitted || use.abort.signal.aborted) throw new VaultError('CANCELLED'); use.submitted = true } }
      } },
  }
  const vault = new LocalPasswordVault(dependencies); disposals.push(vault)
  await vault.list(person)
  const input = { origin: 'https://login.example.test:8443', account: randomBytes(24).toString('base64url'), password: randomBytes(48).toString('base64url') }
  const saved = await vault.save(person, randomUUID(), input)
  const checked = await vault.checkReference(actor, saved.reference)
  if (checked.status !== 'valid') throw new Error('synthetic fixture not ready')
  const binding: VaultUseBinding = { accountId: owner, installationId: checked.installationId, agentId: randomUUID(), sessionId: randomUUID(), browserId: randomUUID(), loginSurfaceId: randomUUID(), loginSurfaceEpoch: randomUUID(), frameId: randomUUID(), documentId: randomUUID(), formFingerprint: 'synthetic-form',
    credentialId: saved.reference.id, credentialVersion: String(saved.reference.version), lockEpoch: saved.reference.epoch, origin: input.origin, operation: 'login-submit', requestId: randomUUID(), useId: randomUUID() }
  function issue(value = binding): VaultUseCapability {
    const capability = {} as VaultUseCapability, abort = new AbortController(); controllers.push(abort)
    issued.set(capability, { binding: value, claimed: false, submitted: false, abort }); return capability
  }
  return { vault, owner, person, actor, input, saved, binding, issue, fill, cleanup, settle, dependencies }
}

describe('trusted internal browser sink with synthetic authority', () => {
  it('releases the planned values in order, computes a one-time code, and fills only on its websites unless approved elsewhere', async () => {
    const f = await scenario(), key = randomUUID(), otp = randomUUID(), seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const saved = await f.vault.save(f.person, randomUUID(), { origin: 'https://api.example.test', account: '', password: '', sites: ['https://deploy.example.test'],
      fields: [{ id: key, name: 'API Key', value: 'sk-synthetic', secret: true }, { id: otp, name: 'TOTP', value: seed, secret: true }] })
    const bind = (origin: string): VaultUseBinding => ({ ...f.binding, credentialId: saved.reference.id, credentialVersion: String(saved.reference.version),
      lockEpoch: saved.reference.epoch, origin, requestId: randomUUID(), useId: randomUUID() })
    let got: string[] = [], buffers: readonly Buffer[] = []
    f.fill.mockImplementation(async (_bound, secrets, control) => {
      buffers = secrets.values; got = secrets.values.map(value => value.toString()); await control.prepareSubmission(); control.claimSubmission(); return 'submitted_unconfirmed'
    })
    const plan = { values: [{ kind: 'field', id: key }, { kind: 'code', id: otp }], elsewhere: false } as const
    const own = bind('https://api.example.test'), site = bind('https://deploy.example.test')
    expect((await f.vault.useCredential(f.issue(own), own, plan)).status).toBe('submitted_unconfirmed')
    const before = Date.now()
    expect((await f.vault.useCredential(f.issue(site), site, plan)).status).toBe('submitted_unconfirmed')
    expect(got[0]).toBe('sk-synthetic'); expect([totpCode(seed, before), totpCode(seed)]).toContain(got[1])
    expect(buffers.every(buffer => buffer.every(byte => byte === 0))).toBe(true)
    const away = bind('https://other.example.test')
    expect((await f.vault.useCredential(f.issue(away), away, plan)).status).toBe('unavailable')
    const approved = bind('https://other.example.test')
    expect((await f.vault.useCredential(f.issue(approved), approved, { ...plan, elsewhere: true })).status).toBe('submitted_unconfirmed')
    // No account was saved: nothing is filled, rather than an empty value.
    const empty = bind('https://api.example.test')
    expect((await f.vault.useCredential(f.issue(empty), empty, { values: [{ kind: 'account' }], elsewhere: false })).status).toBe('unavailable')
    const unknown = bind('https://api.example.test')
    expect((await f.vault.useCredential(f.issue(unknown), unknown, { values: [{ kind: 'field', id: randomUUID() }], elsewhere: false })).status).toBe('unavailable')
    expect(f.fill).toHaveBeenCalledTimes(3)
  })
  it('fills what the person typed: in place of a missing saved value, or alone when nothing is saved, and never a stored one for a typed slot', async () => {
    const f = await scenario()
    let got: string[] = []
    f.fill.mockImplementation(async (_bound, secrets, control) => { got = secrets.values.map(value => value.toString()); await control.prepareSubmission(); control.claimSubmission(); return 'submitted_unconfirmed' })
    const again = (value: Partial<VaultUseBinding> = {}): VaultUseBinding => ({ ...f.binding, requestId: randomUUID(), useId: randomUUID(), ...value })
    // A saved account, a password typed on the card instead of the stored one, for this use only.
    const typed = again()
    expect((await f.vault.useCredential(f.issue(typed), typed, { ...LOGIN, typed: [undefined, 'typed-on-card'] })).status).toBe('submitted_unconfirmed')
    expect(got).toEqual([f.input.account, 'typed-on-card'])
    // Nothing saved for the website: every value typed, bound to no stored credential, on the vault's current lock.
    const epoch = f.vault.state().epoch, transient = again({ credentialId: `typed:${randomUUID()}`, credentialVersion: '0', lockEpoch: epoch, origin: 'https://new.example.test' })
    const plan = { values: [{ kind: 'typed' }, { kind: 'typed' }], elsewhere: false, transient: true } as const
    expect((await f.vault.useCredential(f.issue(transient), transient, { ...plan, typed: ['dev@example.test', 'only-this-once'] })).status).toBe('submitted_unconfirmed')
    expect(got).toEqual(['dev@example.test', 'only-this-once'])
    // A slot left untyped, or a transient use naming a stored value, fills nothing.
    const missing = again({ credentialId: `typed:${randomUUID()}`, credentialVersion: '0', lockEpoch: epoch, origin: 'https://new.example.test' })
    expect((await f.vault.useCredential(f.issue(missing), missing, { ...plan, typed: ['dev@example.test'] })).status).toBe('unavailable')
    const named = again({ credentialId: `typed:${randomUUID()}`, credentialVersion: '0', lockEpoch: epoch })
    expect((await f.vault.useCredential(f.issue(named), named, { values: [{ kind: 'password' }], elsewhere: false, transient: true, typed: ['x'] })).status).toBe('unavailable')
    const untyped = again()
    expect((await f.vault.useCredential(f.issue(untyped), untyped, { values: [{ kind: 'account' }, { kind: 'typed' }], elsewhere: false })).status).toBe('unavailable')
    expect(f.fill).toHaveBeenCalledTimes(2)
  })
  it('releases buffers only after pre-audit, claims once, and clears buffers and late submission rights', async () => {
    const { vault, binding, issue, fill, person, input } = await scenario(), capability = issue()
    let account!: Buffer, password!: Buffer, control!: VaultUseControl, matched = false
    fill.mockImplementationOnce(async (_bound, secrets, lease) => {
      account = secrets.values[0]!; password = secrets.values[1]!; control = lease
      const recorded = await vault.readAudit(person)
      expect(recorded.some(record => record.action === 'use' && record.outcome === 'pending')).toBe(true)
      matched = password.equals(Buffer.from(input.password)); lease.assertCurrent(); await lease.prepareSubmission(); lease.claimSubmission()
      expect(() => lease.claimSubmission()).toThrow(VaultError)
      return 'submitted_unconfirmed'
    })
    const outcome = await vault.useCredential(capability, binding, LOGIN)
    expect(outcome).toEqual({ status: 'submitted_unconfirmed', retry: false, retainIsolatedLogin: false }); expect(matched).toBe(true)
    expect(account.every(byte => byte === 0)).toBe(true); expect(password.every(byte => byte === 0)).toBe(true)
    expect(() => control.claimSubmission()).toThrow(VaultError)
    expect((await vault.useCredential(capability, binding, LOGIN)).status).toBe('unavailable'); expect(fill).toHaveBeenCalledOnce()
  })
  it('rejects serialized/forged capabilities and mismatched owner/site/version before releasing secrets', async () => {
    const { vault, binding, issue, fill, cleanup, settle } = await scenario()
    expect((await vault.useCredential({} as VaultUseCapability, binding, LOGIN)).status).toBe('unavailable')
    expect(cleanup).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled()
    for (const changed of [{ ...binding, accountId: randomUUID() }, { ...binding, origin: 'https://sibling.example.test' }, { ...binding, credentialVersion: '01' }]) {
      expect((await vault.useCredential(issue(changed), changed, LOGIN)).status).toBe('unavailable')
    }
    expect(fill).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(3); expect(settle).toHaveBeenCalledTimes(3)
  })
  it('requires a fresh actual-actor reference check and reports lock/old-version invalidation', async () => {
    const { vault, saved, actor, person } = await scenario()
    expect((await vault.checkReference({}, saved.reference)).status).toBe('unavailable')
    await vault.save(person, randomUUID(), { origin: 'https://login.example.test:8443', account: randomUUID(), password: randomUUID() }, saved.reference)
    expect((await vault.checkReference(actor, saved.reference)).status).toBe('invalidated')
    await vault.lock(); expect((await vault.checkReference(actor, saved.reference)).status).toBe('invalidated')
  })
  it('does not call the sink when the pre-use audit fails and retains the isolated login surface', async () => {
    const { vault, binding, issue, fill, cleanup } = await scenario(), original = VaultDisk.prototype.write
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) { if (path.includes('/audit/')) throw new Error('synthetic raw error'); return original.call(this, path, bytes) })
    expect(await vault.useCredential(issue(), binding, LOGIN)).toEqual({ status: 'unavailable', retry: false, retainIsolatedLogin: true })
    expect(fill).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce()
  })
  it('keeps post-effect audit failure uncertain, with no retry or isolated-surface handoff', async () => {
    const { vault, binding, issue, fill } = await scenario(), original = VaultDisk.prototype.write
    let writes = 0
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) { if (path.includes('/audit/') && ++writes === 3) throw new Error('synthetic page echo'); return original.call(this, path, bytes) })
    expect(await vault.useCredential(issue(), binding, LOGIN)).toEqual({ status: 'uncertain', retry: false, retainIsolatedLogin: true })
    expect(fill).toHaveBeenCalledOnce(); expect(vault.state().status).toBe('unavailable')
  })
  it('blocks a submission when audit fails between filling and claiming the submission', async () => {
    const { vault, binding, issue, fill } = await scenario(), original = VaultDisk.prototype.write
    let writes = 0, submissions = 0
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) { if (path.includes('/audit/') && ++writes === 2) throw new Error('synthetic pre-submit failure'); return original.call(this, path, bytes) })
    fill.mockImplementationOnce(async (_bound, _secrets, control) => {
      // Optional only in this regression instrument: the reviewed baseline lacks the new method.
      await control.prepareSubmission?.(); control.claimSubmission(); submissions += 1; return 'submitted_unconfirmed'
    })
    const outcome = await vault.useCredential(issue(), binding, LOGIN)
    // Test the observed effect outside the sink: exceptions inside the sink are deliberately sanitized.
    expect(submissions).toBe(0)
    expect(outcome).toEqual({ status: 'uncertain', retry: false, retainIsolatedLogin: true })
  })
  it('cannot revive a use when a pre-submit audit receipt completes after lock', async () => {
    const { vault, binding, issue, fill } = await scenario(), original = VaultDisk.prototype.write
    let writes = 0, releaseWrite!: () => void, submissions = 0
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.includes('/audit/') && ++writes === 2) await new Promise<void>(resolve => { releaseWrite = resolve })
      return original.call(this, path, bytes)
    })
    fill.mockImplementationOnce(async (_bound, _secrets, control) => { await control.prepareSubmission(); control.claimSubmission(); submissions += 1; return 'submitted_unconfirmed' })
    const using = vault.useCredential(issue(), binding, LOGIN)
    await vi.waitFor(() => expect(typeof releaseWrite).toBe('function'))
    const locking = vault.lock('os-lock'); releaseWrite()
    expect((await using).status).toBe('uncertain'); await locking
    expect(submissions).toBe(0)
  })
  it('zeroes live buffers synchronously on lock and rejects a later submission', async () => {
    const { vault, binding, issue, fill } = await scenario()
    let password!: Buffer, submit!: () => void, release!: () => void
    fill.mockImplementationOnce(async (_bound, secrets, control) => { password = secrets.values[1]!; submit = control.claimSubmission; await new Promise<void>(resolve => { release = resolve }); control.claimSubmission(); return 'submitted_unconfirmed' })
    const using = vault.useCredential(issue(), binding, LOGIN)
    await vi.waitFor(() => expect(typeof release).toBe('function'))
    const locking = vault.lock(); expect(password.every(byte => byte === 0)).toBe(true); expect(() => submit()).toThrow(VaultError)
    release(); expect((await using).status).toBe('uncertain'); await locking
  })
  it('invalidates an edit immediately and waits for in-flight cleanup before reporting saved', async () => {
    const { vault, binding, issue, fill, cleanup, dependencies, saved, person } = await scenario()
    let password!: Buffer, release!: () => void, confirmCleanup!: () => void
    const cleaned = new Promise<void>(resolve => { confirmCleanup = resolve })
    vi.mocked(dependencies.invalidate).mockImplementationOnce(async () => cleaned)
    cleanup.mockImplementationOnce(async () => { confirmCleanup(); return { status: 'cleaned' } })
    fill.mockImplementationOnce(async (_bound, secrets, control) => { password = secrets.values[1]!; await new Promise<void>(resolve => { release = resolve }); control.claimSubmission(); return 'submitted_unconfirmed' })
    const using = vault.useCredential(issue(), binding, LOGIN); await vi.waitFor(() => expect(typeof release).toBe('function'))
    const editing = vault.save(person, randomUUID(), { origin: binding.origin, account: randomUUID(), password: randomUUID() }, saved.reference)
    expect(password.every(byte => byte === 0)).toBe(true)
    release(); expect((await using).status).toBe('uncertain'); expect((await editing).reference.version).toBe(2)
  })
  it('does not interpret cleaned as authority to hand back the isolated surface, and keeps unresolved cleanup isolated', async () => {
    const { vault, binding, issue, cleanup } = await scenario()
    cleanup.mockResolvedValueOnce({ status: 'isolated_login_retained' } as never)
    const result = await vault.useCredential(issue(), binding, LOGIN)
    expect(result.retainIsolatedLogin).toBe(true)
  })
  it('settles only after buffers are cleared and issues a proof bound to the complete receipt/context', async () => {
    const { vault, binding, issue, fill, settle, person } = await scenario(), capability = issue()
    let password!: Buffer, zeroAtSettlement = false
    fill.mockImplementationOnce(async (_bound, secrets, control) => { password = secrets.values[1]!; await control.prepareSubmission(); control.claimSubmission(); return 'submitted_unconfirmed' })
    settle.mockImplementationOnce(async () => { zeroAtSettlement = password.every(byte => byte === 0) })
    expect((await vault.useCredential(capability, binding, LOGIN)).status).toBe('submitted_unconfirmed')
    expect(zeroAtSettlement).toBe(true); expect(settle).toHaveBeenCalledOnce()
    const { postUseAudit, ...context } = settle.mock.calls[0][0]
    expect(context.capability === capability).toBe(true); expect(context.binding).toEqual(binding)
    expect(postUseAudit.status).toBe('recorded')
    if (postUseAudit.status !== 'recorded') throw new Error('synthetic receipt missing')
    expect(vault.outcomeAudit.matches(postUseAudit, context)).toBe(true)
    expect((await vault.readAudit(person)).some(record => record.id === postUseAudit.eventId && record.useId === binding.useId && record.outcome === context.outcome)).toBe(true)
    expect(vault.outcomeAudit.matches({ ...postUseAudit, eventId: randomUUID() }, context)).toBe(false)
    expect(vault.outcomeAudit.matches({ ...postUseAudit, recordId: randomUUID() }, context)).toBe(false)
    expect(vault.outcomeAudit.matches({ ...postUseAudit, proof: { ...postUseAudit.proof } }, context)).toBe(false)
    expect(vault.outcomeAudit.matches(postUseAudit, { ...context, capability: {} as VaultUseCapability })).toBe(false)
    expect(vault.outcomeAudit.matches(postUseAudit, { ...context, outcome: 'login_confirmed' })).toBe(false)
    expect(vault.outcomeAudit.matches(postUseAudit, { ...context, effectPossible: false })).toBe(false)
    for (const key of Object.keys(binding)) expect(vault.outcomeAudit.matches(postUseAudit, { ...context, binding: { ...binding, [key]: randomUUID() } })).toBe(false)
  })
  it('requires a newly persisted proof when person interaction changes the actual outcome', async () => {
    const { vault, binding, issue, fill, settle } = await scenario()
    fill.mockResolvedValueOnce('person_interaction_required' as never)
    expect((await vault.useCredential(issue(), binding, LOGIN)).status).toBe('person_interaction_required')
    const { postUseAudit, ...oldContext } = settle.mock.calls[0][0], next = { ...oldContext, outcome: 'submitted_unconfirmed' as const }
    if (postUseAudit.status !== 'recorded') throw new Error('synthetic receipt missing')
    expect(vault.outcomeAudit.matches(postUseAudit, next)).toBe(false)
    const fresh = await vault.outcomeAudit.appendOutcome(next)
    expect(fresh.status).toBe('recorded')
    if (fresh.status !== 'recorded') throw new Error('synthetic receipt missing')
    expect(fresh.proof === postUseAudit.proof).toBe(false); expect(fresh.eventId === postUseAudit.eventId).toBe(false)
    expect(vault.outcomeAudit.matches(fresh, next)).toBe(true)
  })
  it('never gives a forged unclaimed context an outcome proof or writes its guessed metadata', async () => {
    const { vault, binding, person } = await scenario(), before = (await vault.readAudit(person)).length
    expect(await vault.outcomeAudit.appendOutcome({ capability: {} as VaultUseCapability, binding, outcome: 'login_confirmed', effectPossible: true })).toEqual({ status: 'uncertain' })
    expect((await vault.readAudit(person)).length).toBe(before)
  })
  it('notifies the claimed use on audit failure with no proof, and retains on a failed settle callback', async () => {
    const failed = await scenario(), original = VaultDisk.prototype.write
    let writes = 0
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) { if (path.includes('/audit/') && ++writes === 3) throw new Error('synthetic audit failure'); return original.call(this, path, bytes) })
    expect(await failed.vault.useCredential(failed.issue(), failed.binding, LOGIN)).toEqual({ status: 'uncertain', retry: false, retainIsolatedLogin: true })
    expect(failed.settle).toHaveBeenCalledOnce(); expect(failed.settle.mock.calls[0][0].postUseAudit.status).toBe('uncertain')
    vi.restoreAllMocks()
    const broken = await scenario(); broken.settle.mockRejectedValueOnce(new Error('synthetic settle failure'))
    expect(await broken.vault.useCredential(broken.issue(), broken.binding, LOGIN)).toEqual({ status: 'uncertain', retry: false, retainIsolatedLogin: true })
    expect(broken.settle).toHaveBeenCalledOnce()
  })
  it.each(['lock', 'clear-audit', 'edit'] as const)('invalidates outcome proofs after %s using the same vault lifecycle', async operation => {
    const { vault, binding, issue, settle, person, saved } = await scenario()
    await vault.useCredential(issue(), binding, LOGIN)
    const { postUseAudit, ...context } = settle.mock.calls[0][0]
    if (postUseAudit.status !== 'recorded') throw new Error('synthetic receipt missing')
    if (operation === 'lock') { await vault.lock(); await vault.list(person) }
    else if (operation === 'edit') await vault.save(person, randomUUID(), { origin: binding.origin, account: randomUUID(), password: randomUUID() }, saved.reference)
    else await vault.clearAudit(person)
    expect(vault.outcomeAudit.matches(postUseAudit, context)).toBe(false)
    expect((await vault.outcomeAudit.appendOutcome(context)).status).toBe('uncertain')
  })
  it('does not call or claim an old sink without the fixed settlement adapter', async () => {
    const { vault, binding, issue, fill, cleanup } = await scenario(false), capability = issue()
    expect(await vault.useCredential(capability, binding, LOGIN)).toEqual({ status: 'unavailable', retry: false, retainIsolatedLogin: true })
    expect(fill).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled()
  })
  it('keeps the construction-time sink when the host dependency object is later replaced', async () => {
    const { vault, binding, issue, dependencies, fill, settle } = await scenario(), replacement = vi.fn()
    dependencies.browser = { ...dependencies.browser!, fillAndSubmit: replacement, settle: replacement }
    expect((await vault.useCredential(issue(), binding, LOGIN)).status).toBe('submitted_unconfirmed')
    expect(fill).toHaveBeenCalledOnce(); expect(settle).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled()
  })
  it('does not issue a late post-use proof when its durable write completes after lock', async () => {
    const { vault, binding, issue, settle } = await scenario(), original = VaultDisk.prototype.write
    let writes = 0, releaseWrite!: () => void
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.includes('/audit/') && ++writes === 3) await new Promise<void>(resolve => { releaseWrite = resolve })
      return original.call(this, path, bytes)
    })
    const using = vault.useCredential(issue(), binding, LOGIN)
    await vi.waitFor(() => expect(typeof releaseWrite).toBe('function'))
    const locking = vault.lock('os-lock'); releaseWrite()
    expect(await using).toEqual({ status: 'uncertain', retry: false, retainIsolatedLogin: true }); await locking
    expect(settle).toHaveBeenCalledOnce(); expect(settle.mock.calls[0][0].postUseAudit.status).not.toBe('recorded')
  })
})
