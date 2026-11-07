import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { VaultDisk } from '../../../apps/desktop/electron/password-vault/disk'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import type { VaultDependencies, VaultUseBinding, VaultUseCapability } from '../../../apps/desktop/electron/password-vault/contracts'
import { PasswordFeatureReadiness, PASSWORD_PROTECTIONS, type PasswordInstallation, type PasswordExecutionMode } from '../../../apps/desktop/electron/permissions/password-readiness'
import type { LivePasswordFact } from '../../../apps/desktop/electron/permissions/password-facts'

const writes = vi.hoisted(() => ({ enabled: false, count: 0, afterRename: undefined as undefined | ((path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>(), { constants } = await import('node:fs')
  return { ...fs,
    open: (...args: Parameters<typeof fs.open>) => {
      if (writes.enabled && (typeof args[1] === 'number' ? !!(args[1] & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC)) : /[wa+]/.test(args[1] ?? 'r'))) writes.count++
      return fs.open(...args)
    },
    mkdir: (...args: Parameters<typeof fs.mkdir>) => { if (writes.enabled) writes.count++; return fs.mkdir(...args) },
    rename: async (...args: Parameters<typeof fs.rename>) => { if (writes.enabled) writes.count++; await fs.rename(...args); await writes.afterRename?.(String(args[1])) },
  }
})
const roots: string[] = [], vaults: LocalPasswordVault[] = []
afterEach(async () => {
  writes.enabled = false; writes.count = 0; writes.afterRename = undefined; vi.restoreAllMocks()
  for (const vault of vaults.splice(0)) await vault.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture(provider = true, revokedSignal?: () => unknown) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-live-canary-')); roots.push(root)
  const person = {}, actor = {}, key = randomBytes(32), abort = new AbortController(), useAbort = new AbortController()
  const state = { live: true, deliveries: 0, submissions: 0 }, issued = new WeakMap<object, VaultUseBinding>()
  const assertCurrent = vi.fn(() => { if (!state.live) throw new Error('synthetic disabled fact') })
  const acquireFeatureGuard = vi.fn<NonNullable<VaultDependencies['acquireFeatureGuard']>>(async () => ({ status: 'ready', signal: abort.signal, assertCurrent }))
  // Only this regression instrument retains the legacy field so the old implementation reaches the unsafe path.
  const legacy = vi.fn(async () => undefined)
  const dependencies = { root: join(root, 'private', 'password-vault', 'v1'), accountId: randomUUID(), installationBinding: randomUUID(),
    assertLocalPerson: (value: object) => { if (value !== person) throw new Error('synthetic person rejected') },
    assertOwnedLocalAgent: (value: object) => { if (value !== actor) throw new Error('synthetic actor rejected') },
    assertPrivateStorageReady: vi.fn(async () => undefined), ...{ assertFeatureReady: legacy },
    ...(provider ? { acquireFeatureGuard } : {}),
    keys: { verifyPerson: vi.fn(async () => undefined), wrap: vi.fn(async (value: Buffer, binding: string) => JSON.stringify(seal(key, value, binding))),
      unwrap: async (value: string, binding: string) => unseal(key, JSON.parse(value), binding) },
    invalidate: vi.fn(async () => { useAbort.abort() }),
    browser: {
      claimCredentialSink: (capability: VaultUseCapability, binding: VaultUseBinding) => {
        if (JSON.stringify(issued.get(capability)) !== JSON.stringify(binding)) throw new Error('synthetic capability rejected')
        issued.delete(capability)
        return { signal: useAbort.signal, revokedSignal: revokedSignal ? revokedSignal() as AbortSignal : useAbort.signal,
          assertCurrent: () => { if (useAbort.signal.aborted) throw new Error('synthetic revoked') }, claimSubmission: () => { state.submissions++ } }
      },
      fillAndSubmit: vi.fn(async (_binding, _secret, control) => { state.deliveries++; await control.prepareSubmission(); control.claimSubmission(); return 'submitted_unconfirmed' as const }),
      cleanup: vi.fn(async () => ({ status: 'cleaned' as const })), settle: async () => undefined,
    },
  } satisfies VaultDependencies
  const vault = new LocalPasswordVault(dependencies); vaults.push(vault)
  const invalidate = (kind: 'closed' | 'revoked') => { state.live = false; if (kind === 'revoked') abort.abort() }
  const setup = async () => { const material = await vault.beginSetup(person); await vault.confirmRecovery(person, material.setupId, material.recoveryMaterial) }
  const use = async () => {
    const saved = await vault.save(person, randomUUID(), { origin: 'https://login.example.test', account: randomUUID(), password: randomBytes(32).toString('base64url') })
    const checked = await vault.checkReference(actor, saved.reference)
    if (checked.status !== 'valid') throw new Error('synthetic fixture unavailable')
    const binding: VaultUseBinding = { requestId: randomUUID(), useId: randomUUID(), accountId: dependencies.accountId, installationId: checked.installationId,
      agentId: randomUUID(), sessionId: randomUUID(), browserId: randomUUID(), loginSurfaceId: randomUUID(), loginSurfaceEpoch: randomUUID(), documentId: randomUUID(), frameId: randomUUID(),
      formFingerprint: 'synthetic-form', credentialId: saved.reference.id, credentialVersion: String(saved.reference.version), lockEpoch: saved.reference.epoch, origin: saved.origin, operation: 'login-submit' }
    const capability = {} as VaultUseCapability; issued.set(capability, binding); return { capability, binding }
  }
  return { vault, person, dependencies, state, acquireFeatureGuard, assertCurrent, legacy, invalidate, setup, use }
}
const observeWrites = () => { writes.count = 0; writes.enabled = true }

describe('live password feature guard held by storage', () => {
  it('holds one live save qualification across both setup steps and captures its provider once', async () => {
    const f = await fixture(), replacement = vi.fn(async () => { throw new Error('replaced dependency') })
    f.dependencies.acquireFeatureGuard = replacement
    await f.setup()
    expect(f.acquireFeatureGuard).toHaveBeenCalledOnce(); expect(f.acquireFeatureGuard.mock.calls[0]?.[0]).toBe('save')
    expect(replacement).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled()
    const request = await f.use()
    expect((await f.vault.useCredential(request.capability, request.binding)).status).toBe('submitted_unconfirmed')
    expect(f.acquireFeatureGuard.mock.calls.map(call => call[0])).toEqual(['save', 'save', 'use'])
    expect(f.state.deliveries).toBe(1); expect(f.state.submissions).toBe(1)
  })
  it('denies a missing new adapter even when the legacy void callback resolves', async () => {
    const f = await fixture(false); observeWrites()
    const delivered = await f.vault.beginSetup(f.person).then(() => true, () => false)
    expect(delivered).toBe(false); expect(writes.count).toBe(0)
  })
  it.each(['closed', 'revoked'] as const)('rechecks after person verification when %s without delivering recovery material', async kind => {
    const f = await fixture(), entered = deferred(), release = deferred()
    f.dependencies.keys.verifyPerson.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const pending = f.vault.beginSetup(f.person).then(() => true, () => false)
    await entered.promise; observeWrites(); f.invalidate(kind); release.resolve()
    expect(await pending).toBe(false); expect(writes.count).toBe(0)
  })
  it.each(['closed', 'revoked'] as const)('reuses the setup guard across recovery confirmation and refuses post-wrap writes when %s', async kind => {
    const f = await fixture(), material = await f.vault.beginSetup(f.person), entered = deferred(), release = deferred()
    const wrap = f.dependencies.keys.wrap.getMockImplementation()!
    f.dependencies.keys.wrap.mockImplementationOnce(async (key, binding) => { entered.resolve(); await release.promise; return wrap(key, binding) })
    const pending = f.vault.confirmRecovery(f.person, material.setupId, material.recoveryMaterial).then(() => true, () => false)
    await entered.promise; observeWrites(); f.invalidate(kind); release.resolve()
    expect(await pending).toBe(false); expect(writes.count).toBe(0)
  })
  it('cannot replace an invalidated pending setup with a fresh guard at confirmation', async () => {
    const f = await fixture(), material = await f.vault.beginSetup(f.person)
    f.invalidate('revoked'); f.state.live = true; observeWrites()
    const result = await f.vault.confirmRecovery(f.person, material.setupId, material.recoveryMaterial).then(() => true, () => false)
    expect(result).toBe(false); expect(f.acquireFeatureGuard).toHaveBeenCalledOnce()
    expect(f.dependencies.keys.wrap).not.toHaveBeenCalled(); expect(writes.count).toBe(0)
  })
  it.each(['closed', 'revoked'] as const)('rechecks at the actual data write after an awaited gate when %s', async kind => {
    const f = await fixture(); await f.setup()
    const entered = deferred(), release = deferred(), original = VaultDisk.prototype.write
    let blocked = false
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, ...args) {
      if (!blocked && args[0].endsWith('/vault.json')) { blocked = true; entered.resolve(); await release.promise }
      return original.apply(this, args)
    })
    const pending = f.vault.save(f.person, randomUUID(), { origin: 'https://login.example.test', account: randomUUID(), password: randomUUID() }).then(() => true, () => false)
    await entered.promise; observeWrites(); f.invalidate(kind); release.resolve()
    expect(await pending).toBe(false); expect(writes.count).toBe(0)
  })
  it.each(['closed', 'revoked'] as const)('rechecks after pre-use audit waits when %s and delivers no buffers', async kind => {
    const f = await fixture(); await f.setup(); const request = await f.use()
    const entered = deferred(), release = deferred(), original = VaultDisk.prototype.write
    let blocked = false
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, ...args) {
      if (!blocked && args[0].includes('/audit/')) { blocked = true; entered.resolve(); await release.promise }
      return original.apply(this, args)
    })
    const pending = f.vault.useCredential(request.capability, request.binding)
    await entered.promise; f.invalidate(kind); release.resolve(); await pending
    expect(f.state.deliveries).toBe(0); expect(f.state.submissions).toBe(0)
  })
  it.each(['missing', 'wrong-type', 'aborted'] as const)('refuses %s approval revocation signal before preparing or delivering buffers', async kind => {
    const abort = new AbortController(); abort.abort()
    const candidate = kind === 'missing' ? undefined : kind === 'wrong-type' ? { aborted: false } : abort.signal
    const f = await fixture(true, () => candidate); await f.setup(); const request = await f.use()
    const result = await f.vault.useCredential(request.capability, request.binding)
    expect(result.status).toBe('unavailable'); expect(f.state.deliveries).toBe(0); expect(f.state.submissions).toBe(0)
    expect(f.acquireFeatureGuard.mock.calls.map(call => call[0])).toEqual(['save', 'save'])
  })
  it('clears already delivered buffers synchronously on live revocation and refuses later submission', async () => {
    const f = await fixture(); await f.setup(); const request = await f.use(), entered = deferred(), release = deferred()
    let secret: { account: Buffer; password: Buffer } | undefined, stillCurrent = true
    f.dependencies.browser.fillAndSubmit.mockImplementationOnce(async (_binding, value, control) => {
      f.state.deliveries++; secret = value; await control.prepareSubmission(); entered.resolve(); await release.promise
      try { control.claimSubmission() } catch { stillCurrent = false }
      return 'submitted_unconfirmed'
    })
    const pending = f.vault.useCredential(request.capability, request.binding)
    await entered.promise
    const hadPlaintext = !!secret?.password.some(byte => byte !== 0)
    f.invalidate('revoked')
    const clearedSynchronously = !!secret && [secret.account, secret.password].every(bytes => bytes.every(byte => byte === 0))
    release.resolve(); const result = await pending
    expect(hadPlaintext).toBe(true); expect(clearedSynchronously).toBe(true)
    expect(stillCurrent).toBe(false); expect(f.state.submissions).toBe(0); expect(result.status).toBe('uncertain')
  })
  it.each(['fill', 'cleanup'] as const)('rejects a late successful %s result after live qualification closes', async phase => {
    const f = await fixture(); await f.setup(); const request = await f.use(), entered = deferred(), release = deferred()
    if (phase === 'fill') {
      f.dependencies.browser.fillAndSubmit.mockImplementationOnce(async (_binding, _value, control) => {
        f.state.deliveries++; await control.prepareSubmission(); control.claimSubmission(); entered.resolve(); await release.promise
        return 'submitted_unconfirmed'
      })
    } else {
      f.dependencies.browser.cleanup.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { status: 'cleaned' } })
    }
    const pending = f.vault.useCredential(request.capability, request.binding)
    await entered.promise; f.invalidate('closed'); release.resolve()
    const result = await pending
    expect(f.state.submissions).toBe(1); expect(result.status).toBe('uncertain'); expect(result.retainIsolatedLogin).toBe(true)
  })
  it('cancels a pending readiness acquisition on lock and ignores its late result', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    let signal: AbortSignal | undefined
    const provider = f.acquireFeatureGuard.getMockImplementation()!
    f.acquireFeatureGuard.mockImplementationOnce(async (operation, current) => { signal = current; entered.resolve(); await release.promise; return provider(operation, current) })
    const pending = f.vault.beginSetup(f.person).then(() => true, () => false)
    await entered.promise; observeWrites(); const locking = f.vault.lock()
    const cancelled = signal?.aborted
    const delivered = await pending
    release.resolve(); await locking
    expect(cancelled).toBe(true); expect(delivered).toBe(false); expect(writes.count).toBe(0)
    expect(f.vault.state().status).toBe('locked')
  })
  it.each(['void', 'unavailable', 'boolean-assert', 'async-assert', 'missing-signal'] as const)('rejects malformed readiness: %s without filesystem mutation', async kind => {
    const f = await fixture()
    const candidate: unknown = kind === 'void' ? undefined : kind === 'unavailable' ? { status: 'unavailable', reason: 'password_permission_unavailable' }
      : { status: 'ready', signal: kind === 'missing-signal' ? undefined : new AbortController().signal,
        assertCurrent: kind === 'boolean-assert' ? () => true : kind === 'async-assert' ? async () => undefined : () => undefined }
    f.acquireFeatureGuard.mockResolvedValueOnce(candidate as Awaited<ReturnType<NonNullable<VaultDependencies['acquireFeatureGuard']>>>)
    observeWrites()
    const result = await f.vault.beginSetup(f.person).then(() => 'delivered', error => error.code as string)
    expect(result).toBe('UNAVAILABLE'); expect(writes.count).toBe(0)
  })
  it('keeps the real permission readiness guard live across a private-file wait', async () => {
    const f = await fixture(), mode = { value: 'enforce' as PasswordExecutionMode }, host = { accountId: f.dependencies.accountId, installationId: randomUUID(), deviceId: randomUUID() }
    function fact<T>(value: T): LivePasswordFact<T> { return { value, generation: randomUUID(), signal: new AbortController().signal, assertCurrent() {} } }
    const modeFact = { ...fact(mode.value) }, ready = fact('ready' as const), installation = fact<PasswordInstallation>(host)
    const readiness = new PasswordFeatureReadiness({ readInstallation: async () => installation, readMode: async () => modeFact,
      readProtections: async () => Object.fromEntries(PASSWORD_PROTECTIONS.map(name => [name, ready])) })
    f.acquireFeatureGuard.mockImplementation(async (operation, signal) => {
      const guard = await readiness.check(operation, signal)
      if (guard.status !== 'ready') throw new Error('synthetic readiness unavailable')
      return guard
    })
    const entered = deferred(), release = deferred()
    f.dependencies.assertPrivateStorageReady.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const pending = f.vault.beginSetup(f.person).then(() => true, () => false)
    await entered.promise; observeWrites(); modeFact.value = 'disabled'; release.resolve()
    expect(await pending).toBe(false); expect(writes.count).toBe(0)
  })
  it('drops its cached key after revocation of an issued write and does not roll back or retry it', async () => {
    const f = await fixture(); await f.setup()
    const entered = deferred(), release = deferred(); let renamed = 0
    writes.afterRename = async path => { if (path.endsWith('/vault.json') && ++renamed === 2) { entered.resolve(); await release.promise } }
    const input = { origin: 'https://login.example.test', account: randomUUID(), password: randomUUID() }
    const pending = f.vault.save(f.person, randomUUID(), input).then(() => 'completed', error => error.code as string)
    await entered.promise; f.invalidate('closed'); release.resolve()
    expect(await pending).toBe('STORAGE_FAILED'); expect(renamed).toBe(2); expect(f.vault.state().status).toBe('unavailable')
    writes.afterRename = undefined
    await f.vault.unlock(f.person)
    expect((await f.vault.list(f.person)).length).toBe(1)
  })
})
