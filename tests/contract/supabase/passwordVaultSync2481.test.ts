/** #2481: two real sync engines (two devices of one account) against the installed backend release. The vaults are
 * in memory; keys, sealing, codes, versions and re-keying are the real ones. Every fixture row rolls back. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VaultError, type VaultKeyProtector } from '../../../apps/desktop/electron/password-vault/contracts'
import type { SyncValue } from '../../../apps/desktop/electron/password-vault/management'
import { VaultSync, type SyncRpc, type SyncVault } from '../../../apps/desktop/electron/password-vault/sync'
import { withContractDatabase } from './database'

type Database = Parameters<Parameters<typeof withContractDatabase>[0]>[0]
const rpc = {
  password_vault_state: [['p_device_id', 'text'], ['p_since', 'bigint']],
  password_vault_initialize: [['p_device_id', 'text'], ['p_public_key', 'text'], ['p_sealed_key', 'text']],
  password_vault_request: [['p_device_id', 'text'], ['p_public_key', 'text'], ['p_commitment', 'text']],
  password_vault_challenge: [['p_approver_device_id', 'text'], ['p_device_id', 'text'], ['p_approver_nonce', 'text']],
  password_vault_reveal: [['p_device_id', 'text'], ['p_device_nonce', 'text']],
  password_vault_approve: [['p_approver_device_id', 'text'], ['p_device_id', 'text'], ['p_public_key', 'text'], ['p_scope', 'text'], ['p_epoch', 'integer'], ['p_shares', 'jsonb']],
  password_vault_dismiss: [['p_caller_device_id', 'text'], ['p_device_id', 'text']],
  password_vault_save: [['p_device_id', 'text'], ['p_item_id', 'uuid'], ['p_expected_version', 'bigint'], ['p_epoch', 'integer'], ['p_wrapped_key', 'text'], ['p_ciphertext', 'text'], ['p_shares', 'jsonb']],
  password_vault_delete: [['p_device_id', 'text'], ['p_item_id', 'uuid'], ['p_expected_version', 'bigint']],
  password_vault_rotate: [['p_device_id', 'text'], ['p_epoch', 'integer'], ['p_remove_device_ids', 'text[]'], ['p_items', 'jsonb'], ['p_shares', 'jsonb']],
} as const

function rpcAs(db: Database, owner: string): SyncRpc {
  return async (name, args) => {
    const parameters = rpc[name as keyof typeof rpc]
    if (!parameters || Object.keys(args).sort().join() !== parameters.map(([key]) => key).sort().join()) throw new Error(`Unexpected vault RPC ${name}`)
    const values = parameters.map(([key, type]) => type === 'jsonb' ? JSON.stringify(args[key]) : args[key])
    await db.query('SAVEPOINT vault_call')
    try {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
      await db.query('SET LOCAL ROLE authenticated')
      const result = await db.query<{ result: unknown }>(`SELECT identity.${name}(${parameters.map(([key, type], index) => `${key} => $${index + 1}::${type}`).join(',')}) AS result`, values)
      await db.query('RESET ROLE'); await db.query('RELEASE SAVEPOINT vault_call')
      return result.rows[0]!.result
    } catch (cause) {
      await db.query('ROLLBACK TO SAVEPOINT vault_call'); await db.query('RESET ROLE'); await db.query('RELEASE SAVEPOINT vault_call')
      throw cause
    }
  }
}
// The Keychain stand-in: a reversible wrap bound to its binding, like safeStorage.
const keys: VaultKeyProtector = {
  async verifyPerson() {},
  async wrap(key, binding) { return Buffer.from(JSON.stringify({ binding, key: key.toString('base64') })).toString('base64') },
  async unwrap(wrapped, binding) {
    const value = JSON.parse(Buffer.from(wrapped, 'base64').toString()) as { binding: string; key: string }
    if (value.binding !== binding) throw new VaultError('CANNOT_UNLOCK')
    return Buffer.from(value.key, 'base64')
  },
}
class MemoryVault implements SyncVault {
  readonly items = new Map<string, SyncValue>()
  sync?: VaultSync
  async syncExport() { return [...this.items].map(([id, value]) => ({ id, ...structuredClone(value) })) }
  async syncApply(changes: { id: string; value?: SyncValue }[]) { for (const change of changes) change.value ? this.items.set(change.id, structuredClone(change.value)) : this.items.delete(change.id) }
  /** A local edit as the real vault does it: the cloud first, then the local copy. */
  async save(id: string, value: SyncValue) { await this.sync!.publish({ kind: 'save', id, value }); this.items.set(id, value) }
  async remove(id: string) { await this.sync!.publish({ kind: 'delete', id }); this.items.delete(id) }
}
const credential = (origin: string, account: string, password: string): SyncValue => ({ origin, account, password, fields: [], grants: [] })
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

let root: string
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'vault-sync-contract-')) })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('password vault sync between two devices of one account', () => {
  it('joins with matching codes, merges, syncs edits, refuses stale ones and locks out a removed device', async () => withContractDatabase(async db => {
    await db.query('BEGIN')
    try {
      const owner = randomUUID(), [macId, laptopId] = [randomUUID(), randomUUID()]
      await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,now(),now())`, [owner, `${owner}@vault.invalid`])
      for (const id of [macId, laptopId]) await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,machine_id)
        VALUES($1,$2,$3,'h','darwin',$4)`, [id, owner, id === macId ? 'Mac' : 'Laptop', `machine-${id}`])
      const engine = (deviceId: string, vault: MemoryVault) => (vault.sync = new VaultSync({ root: join(root, deviceId), ownerId: owner, deviceId, keys, rpc: rpcAs(db, owner), vault, changed() {} }))
      const macVault = new MemoryVault(), laptopVault = new MemoryVault()
      const github = randomUUID(), mail = randomUUID(), laptopOnly = randomUUID(), duplicate = randomUUID()
      macVault.items.set(github, credential('https://github.com', 'me@example.com', 'canary-github'))
      macVault.items.set(mail, { ...credential('https://mail.example.com', 'me', 'canary-mail'), grants: [{ subject: `agent:${randomUUID()}`, level: 'read' }] })
      laptopVault.items.set(laptopOnly, credential('https://laptop.example.com', 'me', 'canary-laptop'))
      laptopVault.items.set(duplicate, credential('https://github.com', 'me@example.com', 'canary-github'))
      const mac = engine(macId, macVault), laptop = engine(laptopId, laptopVault)

      // The first device creates the vault and uploads ciphertext only.
      expect(await mac.refresh()).toMatchObject({ state: 'ready', requests: [] })
      const stored = (await db.query<{ ciphertext: string }>('SELECT ciphertext FROM identity.password_vault_items WHERE owner_user_id=$1', [owner])).rows
      expect(stored).toHaveLength(2)
      expect(stored.map(row => Buffer.from(row.ciphertext, 'base64').toString('latin1')).join()).not.toMatch(/canary|github|example/)

      // The second device asks; the person opens it on the Mac; both screens show the same 6 digits.
      expect(await laptop.refresh()).toEqual({ state: 'joining' })
      expect((await mac.refresh() as any).requests).toEqual([expect.objectContaining({ deviceId: laptopId, label: 'Laptop', stage: 'new' })])
      expect((await mac.challenge(laptopId) as any).requests[0].stage).toBe('waiting')
      const shown = await laptop.refresh() as { state: string; code: string }
      expect(shown.code).toMatch(/^\d{6}$/)
      const request = (await mac.refresh() as any).requests[0]
      expect(request).toMatchObject({ stage: 'compare', code: shown.code })
      await mac.approve(laptopId)

      // Joined: the Mac's items arrive; the laptop-only item goes up; the same site and account become one entry.
      expect(await laptop.refresh()).toMatchObject({ state: 'ready' })
      expect([...laptopVault.items.keys()].sort()).toEqual([github, mail, laptopOnly].sort())
      await settle(); await mac.refresh()
      expect(macVault.items.get(laptopOnly)?.password).toBe('canary-laptop')

      // An edit on one device reaches the other.
      await laptopVault.save(github, credential('https://github.com', 'me@example.com', 'canary-rotated-password'))
      await mac.refresh()
      expect(macVault.items.get(github)?.password).toBe('canary-rotated-password')
      // Editing on top of what this device has not pulled yet is a conflict, not a silent overwrite.
      await macVault.save(mail, credential('https://mail.example.com', 'me', 'canary-mail-2'))
      await expect(laptopVault.save(mail, credential('https://mail.example.com', 'me', 'canary-mail-3'))).rejects.toThrow('STALE_REFERENCE')
      await settle(); await laptop.refresh()
      expect(laptopVault.items.get(mail)?.password).toBe('canary-mail-2')

      // Removing the laptop re-keys; it can no longer write, and only edits made locally stay with it.
      expect((await mac.remove(laptopId) as any).devices.map((device: any) => device.deviceId)).toEqual([macId])
      expect((await db.query<{ key_epoch: number }>('SELECT key_epoch FROM identity.password_vault_heads WHERE owner_user_id=$1', [owner])).rows[0]!.key_epoch).toBe(2)
      await macVault.save(github, credential('https://github.com', 'me@example.com', 'canary-after-removal'))
      expect(await laptop.refresh()).toEqual({ state: 'joining' })
      expect(laptopVault.items.get(github)?.password).toBe('canary-rotated-password')
      await laptopVault.save(laptopOnly, credential('https://laptop.example.com', 'me', 'canary-local-only'))
      await mac.refresh()
      expect(macVault.items.get(laptopOnly)?.password).toBe('canary-laptop')
      // The Mac's request list now shows the laptop asking again; ignoring it leaves the vault as it is.
      expect((await mac.refresh() as any).requests).toEqual([expect.objectContaining({ deviceId: laptopId, stage: 'new' })])
      mac.dispose(); laptop.dispose()
    } finally { await db.query('ROLLBACK') }
  }))
})
