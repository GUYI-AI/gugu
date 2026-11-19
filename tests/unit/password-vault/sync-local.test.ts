import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'
import { VaultError, type VaultDependencies, type VaultKeyProtector } from '../../../apps/desktop/electron/password-vault/contracts'
import type { SyncChange } from '../../../apps/desktop/electron/password-vault/management'
import { VaultSync, syncDirectory } from '../../../apps/desktop/electron/password-vault/sync'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'

// #2481: the local vault publishes each change to the sync engine before committing it, and applies pulled changes.
const owner = randomUUID(), person = {}
const roots: string[] = [], vaults: LocalPasswordVault[] = []
afterEach(async () => {
  for (const vault of vaults.splice(0)) await vault.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(publish: (change: SyncChange) => Promise<void>, root?: string) {
  root ??= await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-sync-')); roots.push(root)
  const wrappingKey = randomBytes(32), invalidate = vi.fn(async () => undefined)
  const keys: VaultKeyProtector = { verifyPerson: async () => undefined,
    wrap: async (key, binding) => JSON.stringify(seal(wrappingKey, key, binding)), unwrap: async (wrapped, binding) => unseal(wrappingKey, JSON.parse(wrapped), binding) }
  const dependencies: VaultDependencies = { root: join(root, owner), accountId: owner, installationBinding: randomUUID(),
    assertLocalPerson: context => { if (context !== person) throw new Error('forged principal') }, assertPrivateStorageReady: async () => undefined,
    acquireFeatureGuard: async () => ({ status: 'ready' as const, signal: new AbortController().signal, assertCurrent() {} }),
    invalidate, keys, sync: { publish } }
  const vault = new LocalPasswordVault(dependencies); vaults.push(vault)
  return { vault, invalidate, keys, root }
}
const input = (password: string) => ({ origin: 'https://github.com', account: 'me@example.com', password })

describe('local vault ↔ sync engine', () => {
  it('publishes the full value before committing; a refused publish leaves the vault unchanged', async () => {
    const published: SyncChange[] = []
    let refuse = false
    const { vault } = await fixture(async change => { if (refuse) throw new VaultError('STALE_REFERENCE'); published.push(structuredClone(change)) })
    const saved = await vault.save(person, randomUUID(), input('first'))
    expect(published).toEqual([{ kind: 'save', id: saved.reference.id, value: { ...input('first'), name: '', accountSecret: false, fields: [], grants: [], sites: [] } }])
    refuse = true
    await expect(vault.save(person, randomUUID(), input('second'), saved.reference)).rejects.toMatchObject({ code: 'STALE_REFERENCE' })
    expect((await vault.reveal(person, saved.reference)).password).toBe('first')
    await expect(vault.setGrants(person, saved.reference, [{ subject: `agent:${randomUUID()}`, level: 'read' }])).rejects.toMatchObject({ code: 'STALE_REFERENCE' })
    expect((await vault.list(person))[0]!.grants).toEqual([])
    await expect(vault.delete(person, randomUUID(), saved.reference)).rejects.toMatchObject({ code: 'STALE_REFERENCE' })
    expect(await vault.list(person)).toHaveLength(1)
    refuse = false
    await vault.delete(person, randomUUID(), saved.reference)
    expect(published.at(-1)).toEqual({ kind: 'delete', id: saved.reference.id })
  })
  it('applies pulled changes: adds, edits with a new local version, deletes, and revokes in-flight references', async () => {
    const { vault, invalidate } = await fixture(async () => {})
    const saved = await vault.save(person, randomUUID(), input('local'))
    const remote = randomUUID()
    await vault.syncApply(person, [{ id: remote, value: { ...input('remote'), origin: 'https://mail.example.com', name: '', accountSecret: false, fields: [], grants: [], sites: [] } },
      { id: saved.reference.id, value: { ...input('edited elsewhere'), name: '', accountSecret: false, fields: [], grants: [], sites: [] } }])
    const listed = await vault.list(person)
    expect(listed.map(item => item.reference.id).sort()).toEqual([saved.reference.id, remote].sort())
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'edit', credentialId: saved.reference.id }))
    await expect(vault.reveal(person, saved.reference)).rejects.toMatchObject({ code: 'STALE_REFERENCE' })
    const edited = listed.find(item => item.reference.id === saved.reference.id)!
    expect(edited.reference.version).toBe(saved.reference.version + 1)
    expect((await vault.reveal(person, edited.reference)).password).toBe('edited elsewhere')
    expect((await vault.syncExport(person)).map(item => item.password).sort()).toEqual(['edited elsewhere', 'remote'])
    await vault.syncApply(person, [{ id: remote }])
    expect((await vault.list(person)).map(item => item.reference.id)).toEqual([saved.reference.id])
    expect(() => vault.syncApply({}, [{ id: saved.reference.id }])).toThrow()
  })
  it('keeps its own state outside the vault root, so a first vault can still be created after sync started', async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'gugu-vault-dir-'))
    const { vault, keys } = await fixture(async () => {}, directory)
    // The engine writes its device key first (the cloud is unreachable here), before the vault exists.
    const sync = new VaultSync({ root: syncDirectory(directory, owner), ownerId: owner, deviceId: randomUUID(), keys, changed() {},
      rpc: async () => { throw new Error('offline') }, vault: { syncExport: () => vault.syncExport(person), syncApply: changes => vault.syncApply(person, changes) } })
    await expect(sync.refresh()).rejects.toMatchObject({ code: 'OFFLINE' })
    await vault.save(person, randomUUID(), input('first'))
    expect(await vault.list(person)).toHaveLength(1)
    sync.dispose()
  })
})
