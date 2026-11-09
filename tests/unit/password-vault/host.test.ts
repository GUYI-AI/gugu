import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createVaultStorage, type VaultFeatureGuardProvider, type VaultStorageDependencies } from '../../../apps/desktop/electron/password-vault/host'
import { VaultError, type VaultBrowserSink } from '../../../apps/desktop/electron/password-vault/contracts'
import type { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import { PasswordFeatureReadiness, PASSWORD_PROTECTIONS } from '../../../apps/desktop/electron/permissions/password-readiness'

const build = vi.hoisted(() => ({ beta: true }))
vi.mock('@gugu/core/shared/passwordBeta', () => ({ get PASSWORD_BETA_ENABLED() { return build.beta } }))

const roots: string[] = [], vaults: LocalPasswordVault[] = []
afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  build.beta = true
})
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-host-canary-')); roots.push(root)
  const person = {}, key = randomBytes(32)
  const verify = vi.fn(async () => undefined), ready = vi.fn(async () => undefined)
  const host: VaultStorageDependencies = { root: join(root, 'private', 'password-vault', 'v1'), accountId: randomUUID(), installationBinding: randomUUID(),
    assertLocalPerson(context) { if (this !== host || context !== person) throw new VaultError('UNAVAILABLE') },
    assertPrivateStorageReady: ready, invalidate: async () => undefined,
    keys: { verifyPerson: verify, wrap: async (value, binding) => JSON.stringify(seal(key, value, binding)), unwrap: async (value, binding) => unseal(key, JSON.parse(value), binding) } }
  const browser: VaultBrowserSink = { claimCredentialSink() { throw new VaultError('UNAVAILABLE') }, fillAndSubmit: async () => 'uncertain',
    cleanup: async () => ({ status: 'isolated_login_retained' }), settle: async () => undefined }
  const acquire = vi.fn<VaultFeatureGuardProvider>(async () => ({ status: 'ready', signal: new AbortController().signal, assertCurrent() {} }))
  const construct = (h = host, b = browser, guard: VaultFeatureGuardProvider = acquire) => {
    const ports = createVaultStorage(h, b, guard); vaults.push(ports.vault); return ports
  }
  return { root, host, browser, acquire, person, verify, ready, construct }
}

describe('fixed host construction of vault storage', () => {
  it.each(['person-cancelled', 'recovery-unconfirmed'] as const)('keeps account setup available after %s despite a persisted installation manifest', async mode => {
    const f = await fixture(), vault = f.construct().vault
    expect(await vault.isInitialized(f.person)).toBe(false)
    expect((await readdir(f.root)).length).toBe(0); expect(f.verify).not.toHaveBeenCalled()
    if (mode === 'person-cancelled') {
      f.verify.mockRejectedValueOnce(new VaultError('CANNOT_UNLOCK'))
      await expect(vault.beginSetup(f.person)).rejects.toMatchObject({ code: 'CANNOT_UNLOCK' })
    } else await vault.beginSetup(f.person)
    expect((await vault.prepareInstallationIdentity()).value.status).toBe('persisted')
    expect(await vault.isInitialized(f.person)).toBe(false)
    await vault.dispose()
    const next = f.construct().vault
    expect(await next.isInitialized(f.person)).toBe(false)
    const setup = await next.beginSetup(f.person)
    await next.confirmRecovery(f.person, setup.setupId, setup.recoveryMaterial)
    expect(await next.isInitialized(f.person)).toBe(true)
    await next.lock()
    expect(await next.isInitialized(f.person)).toBe(true)
  })
  it.each(['missing', 'damaged'] as const)('does not report a %s account document as an uninitialized empty vault', async mode => {
    const f = await fixture(), vault = f.construct().vault
    const setup = await vault.beginSetup(f.person)
    await vault.confirmRecovery(f.person, setup.setupId, setup.recoveryMaterial)
    const manifest = JSON.parse(await readFile(join(f.host.root, 'installation.json'), 'utf8'))
    const path = join(f.host.root, manifest.owners[0], 'vault.json')
    if (mode === 'missing') await rm(path)
    else await writeFile(path, '{}')
    await expect(vault.isInitialized(f.person)).rejects.toMatchObject({ code: mode === 'missing' ? 'DATA_MISSING' : 'DATA_DAMAGED' })
  })
  it('refuses the non-Beta build even with a supplied ready callback and creates nothing', async () => {
    const f = await fixture(); build.beta = false
    expect(() => f.construct()).toThrow(VaultError)
    expect((await readdir(f.root)).length).toBe(0); expect(f.acquire).not.toHaveBeenCalled()
    build.beta = true
    expect(f.construct().vault.state().status).toBe('locked')
  })
  it('prepares one pending installation without writes and persists exactly that UUID through a live save guard', async () => {
    const f = await fixture(), deviceId = randomUUID()
    const fact = <T>(value: T) => ({ value, generation: randomUUID(), signal: new AbortController().signal, assertCurrent() {} })
    const readiness = new PasswordFeatureReadiness({ readInstallation: async () => {
      const identity = await vault.prepareInstallationIdentity()
      return { ...identity, value: { accountId: f.host.accountId, installationId: identity.value.installationId, deviceId } }
    }, readMode: async () => fact('enforce' as const),
    readProtections: async () => Object.fromEntries(PASSWORD_PROTECTIONS.map(kind => [kind, fact('ready' as const)])) })
    const vault: LocalPasswordVault = f.construct(f.host, f.browser, async (operation, signal) => {
      const identity = await vault.prepareInstallationIdentity()
      if (operation === 'use' && identity.value.status !== 'persisted') throw new VaultError('UNAVAILABLE')
      const guard = await readiness.check(operation, signal)
      if (guard.status !== 'ready') throw new VaultError('UNAVAILABLE')
      return guard
    }).vault
    const [first, concurrent] = await Promise.all([vault.prepareInstallationIdentity(), vault.prepareInstallationIdentity()])
    expect(first.value.status).toBe('pending_setup'); expect(first.value.installationId === concurrent.value.installationId).toBe(true)
    expect((await readdir(f.root)).length).toBe(0); expect(f.verify).not.toHaveBeenCalled()
    const material = await vault.beginSetup(f.person)
    await vault.confirmRecovery(f.person, material.setupId, material.recoveryMaterial)
    const persisted = await vault.prepareInstallationIdentity()
    expect(persisted.value.status).toBe('persisted'); expect(persisted.value.installationId === first.value.installationId).toBe(true)
    // A pending save fact stays conservative across its own commit, never upgrades itself into use evidence.
    expect(() => first.assertCurrent()).not.toThrow(); expect(first.value.status).toBe('pending_setup')
    const manifest = JSON.parse(await readFile(join(f.host.root, 'installation.json'), 'utf8'))
    expect(manifest.id === first.value.installationId).toBe(true)
    expect(manifest.id === f.host.installationBinding).toBe(false)
  })
  it('revokes old installation facts on lock and returns the persisted identity with the new lifecycle generation', async () => {
    const f = await fixture(), { vault } = f.construct(), before = await vault.prepareInstallationIdentity()
    const material = await vault.beginSetup(f.person); await vault.confirmRecovery(f.person, material.setupId, material.recoveryMaterial)
    await vault.lock()
    expect(before.signal.aborted).toBe(true); expect(() => before.assertCurrent()).toThrow(VaultError)
    const next = await vault.prepareInstallationIdentity()
    expect(next.value.status).toBe('persisted'); expect(next.value.installationId === before.value.installationId).toBe(true)
    expect(next.generation === before.generation).toBe(false); expect(() => next.assertCurrent()).not.toThrow()
  })
  it('latches a replaced manifest UUID instead of silently substituting a new installation', async () => {
    const f = await fixture(), { vault } = f.construct()
    const material = await vault.beginSetup(f.person); await vault.confirmRecovery(f.person, material.setupId, material.recoveryMaterial)
    const identity = await vault.prepareInstallationIdentity(), path = join(f.host.root, 'installation.json')
    const value = JSON.parse(await readFile(path, 'utf8')); value.id = randomUUID(); await writeFile(path, JSON.stringify(value))
    await expect(vault.prepareInstallationIdentity()).rejects.toMatchObject({ code: 'WRONG_INSTALLATION' })
    expect(() => identity.assertCurrent()).toThrow(VaultError)
  })
  it('captures trusted dependency methods and returns the existing vault audit port', async () => {
    const f = await fixture(), ports = f.construct()
    f.host.assertLocalPerson = () => undefined
    f.host.assertPrivateStorageReady = async () => { throw new Error('replaced protection') }
    f.host.keys.verifyPerson = async () => { throw new Error('replaced person verification') }
    f.host.keys.wrap = async () => { throw new Error('replaced protector') }
    expect(Object.isFrozen(ports)).toBe(true); expect(ports.outcomeAudit).toBe(ports.vault.outcomeAudit)
    expect(() => ports.vault.beginSetup({})).toThrow(VaultError)
    const material = await ports.vault.beginSetup(f.person)
    await ports.vault.confirmRecovery(f.person, material.setupId, material.recoveryMaterial)
    expect(ports.vault.state().status).toBe('unlocked'); expect(f.verify).toHaveBeenCalledOnce()
    expect(f.ready).toHaveBeenCalled()
  })
  it.each(['guard', 'keys', 'person', 'private-files', 'invalidate', 'browser', 'owned-agent', 'clock'] as const)(
    'refuses a malformed %s dependency before reserving a root or creating files', async kind => {
      const f = await fixture(), host = { ...f.host, keys: { ...f.host.keys } }, browser = { ...f.browser }
      const invalid = null as never
      if (kind === 'keys') host.keys.verifyPerson = invalid
      if (kind === 'person') host.assertLocalPerson = invalid
      if (kind === 'private-files') host.assertPrivateStorageReady = invalid
      if (kind === 'invalidate') host.invalidate = invalid
      if (kind === 'browser') browser.settle = invalid
      if (kind === 'owned-agent') host.assertOwnedLocalAgent = false as never
      if (kind === 'clock') host.now = false as never
      expect(() => f.construct(host, browser, kind === 'guard' ? invalid : f.acquire)).toThrow(VaultError)
      expect((await readdir(f.root)).length).toBe(0)
      // A refused construction must not occupy the unique per-root vault service.
      expect(f.construct().vault.state().status).toBe('locked')
    })
})
