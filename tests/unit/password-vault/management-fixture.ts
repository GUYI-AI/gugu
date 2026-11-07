import { afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { VaultError, type VaultDependencies } from '../../../apps/desktop/electron/password-vault/contracts'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import { VaultFile } from '../../../apps/desktop/electron/password-vault/vault-file'
import { binding } from '../../../apps/desktop/electron/password-vault/schema'
import type { VaultCreateInput, VaultMutationOutcome, VaultMutationGuard } from '../../../apps/desktop/electron/password-vault/management-contract'

const roots: string[] = [], vaults: LocalPasswordVault[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const vault of vaults.splice(0)) await vault.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
export function request() {
  const controller = new AbortController(), check = vi.fn<() => void>(() => undefined)
  const guard: VaultMutationGuard = { signal: controller.signal, assertCurrent: check }
  return { controller, check, guard }
}
export function canary(): VaultCreateInput {
  return { origin: 'https://login.example.test', account: randomBytes(24).toString('hex'), password: randomBytes(48).toString('base64url'),
    description: 'Agent-visible test description', fields: [{ name: 'API Key', value: randomBytes(48).toString('base64url') }, { name: 'TOTP seed', value: randomBytes(32).toString('hex') }] }
}
export function committed(outcome: VaultMutationOutcome) {
  if (outcome.status !== 'committed') throw new Error('expected committed management status')
  return outcome.result
}
export async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-management-')); roots.push(root)
  const person = {}, agent = {}, wrappingKey = randomBytes(32)
  const dependencies: VaultDependencies = { root: join(root, 'private', 'password-vault', 'v1'), accountId: randomUUID(), installationBinding: randomUUID(),
    assertLocalPerson: context => { if (context !== person) throw new VaultError('UNAVAILABLE') },
    assertOwnedLocalAgent: context => { if (context !== agent) throw new VaultError('UNAVAILABLE') },
    assertPrivateStorageReady: vi.fn(async () => undefined), acquireFeatureGuard: vi.fn(async () => ({ status: 'ready' as const, signal: new AbortController().signal, assertCurrent() {} })),
    invalidate: vi.fn(async () => undefined), keys: { verifyPerson: async () => undefined,
      wrap: async (key, associated) => JSON.stringify(seal(wrappingKey, key, associated)), unwrap: async (wrapped, associated) => unseal(wrappingKey, JSON.parse(wrapped), associated) } }
  const construct = () => { const vault = new LocalPasswordVault(dependencies); vaults.push(vault); return vault }
  const vault = construct(), setup = await vault.beginSetup(person)
  await vault.confirmRecovery(person, setup.setupId, setup.recoveryMaterial)
  async function payload() {
    const file = new VaultFile(dependencies), document = await file.load(), key = await dependencies.keys.unwrap(document.localKey, binding(document, 'local'))
    try { return file.payload(document, key) } finally { key.fill(0) }
  }
  return { root, vault, port: vault.managementPort, person, agent, dependencies, construct, payload }
}
export async function bytesUnder(root: string): Promise<Buffer[]> {
  const items = await readdir(root, { withFileTypes: true }), result: Buffer[] = []
  for (const item of items) result.push(...(item.isDirectory() ? await bytesUnder(join(root, item.name)) : [await readFile(join(root, item.name))]))
  return result
}
