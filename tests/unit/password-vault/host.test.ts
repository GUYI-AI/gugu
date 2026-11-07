import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { createVaultStorage, type VaultFeatureGuardProvider, type VaultStorageDependencies } from '../../../apps/desktop/electron/password-vault/host'
import { VaultError, type VaultBrowserSink } from '../../../apps/desktop/electron/password-vault/contracts'
import type { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'

const roots: string[] = [], vaults: LocalPasswordVault[] = []
afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
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
  const construct = (h = host, b = browser, guard = acquire) => {
    const ports = createVaultStorage(h, b, guard); vaults.push(ports.vault); return ports
  }
  return { root, host, browser, acquire, person, verify, ready, construct }
}

describe('fixed host construction of vault storage', () => {
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
