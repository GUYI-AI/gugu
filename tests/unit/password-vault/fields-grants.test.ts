import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { VaultError, type VaultDependencies, type VaultKeyProtector } from '../../../apps/desktop/electron/password-vault/contracts'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'

const owner = randomUUID(), person = {}
const roots: string[] = [], vaults: LocalPasswordVault[] = []
afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-fields-')); roots.push(root)
  const wrappingKey = randomBytes(32)
  const keys: VaultKeyProtector = {
    verifyPerson: vi.fn(async () => undefined),
    wrap: vi.fn(async (key, binding) => JSON.stringify(seal(wrappingKey, key, binding))),
    unwrap: vi.fn(async (wrapped, binding) => unseal(wrappingKey, JSON.parse(wrapped), binding)),
  }
  const dependencies: VaultDependencies = { root: join(root, 'private', 'password-vault', 'v1'), accountId: owner, installationBinding: randomUUID(),
    assertLocalPerson: context => { if (context !== person) throw new Error('forged principal') },
    assertPrivateStorageReady: async () => undefined,
    acquireFeatureGuard: async () => ({ status: 'ready' as const, signal: new AbortController().signal, assertCurrent() {} }),
    invalidate: async () => undefined, keys }
  const vault = new LocalPasswordVault(dependencies); vaults.push(vault)
  return { root, vault, keys }
}
async function filesUnder(root: string): Promise<Buffer[]> {
  const items = await readdir(root, { withFileTypes: true })
  return (await Promise.all(items.map(item => item.isDirectory() ? filesUnder(join(root, item.name)) : readFile(join(root, item.name)).then(value => [value])))).flat()
}
const field = (name: string, value: string) => ({ id: randomUUID(), name, value })

describe('key-value credentials, grants and person-only reveal', () => {
  it('stores custom fields encrypted and lists only their names', async () => {
    const { vault, root } = await fixture(), apiKey = randomBytes(24).toString('hex')
    const saved = await vault.save(person, randomUUID(), { origin: 'https://api.example.test', account: 'demo@example.test', password: 'pw-' + randomUUID(), fields: [field('API Key', apiKey)] })
    expect(saved.fields.map(field => field.name)).toEqual(['API Key'])
    expect(JSON.stringify(await vault.list(person)).includes(apiKey)).toBe(false)
    expect((await filesUnder(root)).some(bytes => bytes.includes(apiKey))).toBe(false)
  })
  it('keeps blank account, password and field values on edit, and removes omitted fields', async () => {
    const { vault } = await fixture()
    const keep = field('API Key', 'key-' + randomUUID()), drop = field('TOTP', 'totp-' + randomUUID())
    const first = await vault.save(person, randomUUID(), { origin: 'https://api.example.test', account: 'demo@example.test', password: 'original', fields: [keep, drop] })
    const edited = await vault.save(person, randomUUID(), { origin: 'https://api.example.test', account: '', password: '', fields: [{ ...keep, name: 'Token', value: '' }] }, first.reference)
    expect(edited.fields).toEqual([{ id: keep.id, name: 'Token' }])
    const secrets = await vault.reveal(person, edited.reference)
    expect(secrets.account).toBe('demo@example.test'); expect(secrets.password).toBe('original')
    expect(secrets.fields).toEqual([{ id: keep.id, name: 'Token', value: keep.value }])
  })
  it('rejects a new credential without account or password, and duplicate field names', async () => {
    const { vault } = await fixture()
    await expect(vault.save(person, randomUUID(), { origin: 'https://a.example.test', account: '', password: 'x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(vault.save(person, randomUUID(), { origin: 'https://a.example.test', account: 'a', password: 'x', fields: [field('K', '1'), field('K', '2')] })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
  it('requires local verification for every reveal and returns nothing when it fails', async () => {
    const { vault, keys } = await fixture()
    const saved = await vault.save(person, randomUUID(), { origin: 'https://a.example.test', account: 'a@example.test', password: 'secret' })
    expect(keys.verifyPerson).not.toHaveBeenCalled()
    vi.mocked(keys.verifyPerson).mockRejectedValueOnce(new VaultError('CANNOT_UNLOCK'))
    await expect(vault.reveal(person, saved.reference)).rejects.toMatchObject({ code: 'CANNOT_UNLOCK' })
    expect((await vault.reveal(person, saved.reference)).password).toBe('secret')
    expect(keys.verifyPerson).toHaveBeenCalledTimes(2)
    expect(() => vault.reveal({}, saved.reference)).toThrow(VaultError)
  })
  it('releases only account and password to a server, sealed to its key, without the person step, and audits it', async () => {
    const { vault, keys } = await fixture()
    const { createDeviceKeyPair, openSealed, sealTo } = await import('../../../apps/desktop/electron/password-vault/sync-crypto')
    const server = await createDeviceKeyPair(), apiKey = 'key-' + randomUUID()
    const saved = await vault.save(person, randomUUID(), { origin: 'https://a.example.test', account: 'a@example.test', password: 'secret', fields: [field('API Key', apiKey)] })
    const requestId = randomUUID(), sessionId = randomUUID()
    const sealed = await vault.releaseToServer(saved.reference, plain => sealTo(server.publicKey, plain), { agentId: randomUUID(), sessionId, requestId })
    expect(sealed.includes('secret')).toBe(false)
    expect(JSON.parse((await openSealed(server, sealed)).toString())).toEqual({ account: 'a@example.test', password: 'secret' })
    expect(keys.verifyPerson).not.toHaveBeenCalled()
    expect((await vault.readAudit(person)).some(record => record.action === 'use' && record.requestId === requestId && record.sessionId === sessionId)).toBe(true)
    // A stale reference releases nothing.
    await vault.save(person, randomUUID(), { origin: 'https://a.example.test', account: '', password: 'changed' }, saved.reference)
    await expect(vault.releaseToServer(saved.reference, plain => sealTo(server.publicKey, plain), { agentId: randomUUID(), sessionId, requestId: randomUUID() })).rejects.toBeInstanceOf(VaultError)
  })
  it('grants per credential, dedupes subjects and keeps them across edits', async () => {
    const { vault } = await fixture(), agent = `agent:${randomUUID()}`, project = `project:${randomUUID()}`
    const saved = await vault.save(person, randomUUID(), { origin: 'https://a.example.test', account: 'a', password: 'p' })
    expect(saved.grants).toEqual([])
    const granted = await vault.setGrants(person, saved.reference, [{ subject: agent, level: 'read' }, { subject: project, level: 'write' }, { subject: agent, level: 'write' }])
    expect(granted.grants).toEqual([{ subject: agent, level: 'write' }, { subject: project, level: 'write' }])
    const edited = await vault.save(person, randomUUID(), { origin: 'https://a.example.test', account: '', password: 'new' }, granted.reference)
    expect(edited.grants).toEqual(granted.grants)
    await expect(vault.setGrants(person, saved.reference, [{ subject: 'everyone', level: 'read' }])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
  it('gives only the creating Agent write access to a credential it created', async () => {
    const { vault } = await fixture(), creator = { subject: `agent:${randomUUID()}`, level: 'write' as const }
    const saved = await vault.save(person, randomUUID(), { origin: 'https://a.example.test', account: 'a', password: 'p' }, undefined, creator)
    expect(saved.grants).toEqual([creator])
  })
})
