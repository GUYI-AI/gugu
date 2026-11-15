/** #2481: two real sync engines (two devices of one account) against the installed backend release. The vaults are
 * in memory; keys, sealing, codes, versions and re-keying are the real ones. Every fixture row rolls back. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VaultError, type VaultKeyProtector } from '../../../apps/desktop/electron/password-vault/contracts'
import type { SyncValue } from '../../../apps/desktop/electron/password-vault/management'
import { VaultSync, type SyncRpc, type SyncVault, type SyncView } from '../../../apps/desktop/electron/password-vault/sync'
import * as crypto from '../../../apps/desktop/electron/password-vault/sync-crypto'
import { parseSnapshot, writeEntry } from '../../../apps/desktop/electron/password-vault/sync-members'
import { withContractDatabase } from './database'

type Database = Parameters<Parameters<typeof withContractDatabase>[0]>[0]
const rpc = {
  password_vault_state: [['p_device_id', 'text'], ['p_since', 'bigint'], ['p_log_since', 'bigint']],
  password_vault_revision: [['p_device_id', 'text']],
  password_vault_initialize: [['p_device_id', 'text'], ['p_public_key', 'text'], ['p_sealed_key', 'text'], ['p_entry', 'jsonb']],
  password_vault_request: [['p_device_id', 'text'], ['p_public_key', 'text'], ['p_commitment', 'text']],
  password_vault_challenge: [['p_approver_device_id', 'text'], ['p_device_id', 'text'], ['p_approver_nonce', 'text']],
  password_vault_reveal: [['p_device_id', 'text'], ['p_device_nonce', 'text']],
  password_vault_approve: [['p_approver_device_id', 'text'], ['p_device_id', 'text'], ['p_public_key', 'text'], ['p_scope', 'text'], ['p_epoch', 'integer'], ['p_shares', 'jsonb'], ['p_entry', 'jsonb']],
  password_vault_dismiss: [['p_caller_device_id', 'text'], ['p_device_id', 'text']],
  password_vault_refuse: [['p_caller_device_id', 'text'], ['p_device_id', 'text']],
  password_vault_save: [['p_device_id', 'text'], ['p_item_id', 'uuid'], ['p_expected_version', 'bigint'], ['p_epoch', 'integer'], ['p_wrapped_key', 'text'], ['p_ciphertext', 'text'], ['p_shares', 'jsonb']],
  password_vault_delete: [['p_device_id', 'text'], ['p_item_id', 'uuid'], ['p_expected_version', 'bigint']],
  password_vault_rotate: [['p_device_id', 'text'], ['p_epoch', 'integer'], ['p_remove_device_ids', 'text[]'], ['p_items', 'jsonb'], ['p_shares', 'jsonb'], ['p_recovery', 'jsonb'], ['p_entry', 'jsonb']],
  password_vault_set_recovery: [['p_device_id', 'text'], ['p_epoch', 'integer'], ['p_public_key', 'text'], ['p_verifier', 'text'], ['p_sealed', 'text'], ['p_entry', 'jsonb']],
  password_vault_recovery_begin: [['p_device_id', 'text'], ['p_proof', 'text']],
  password_vault_recover: [['p_device_id', 'text'], ['p_proof', 'text'], ['p_public_key', 'text'], ['p_epoch', 'integer'], ['p_sealed_key', 'text'], ['p_entry', 'jsonb']],
} as const

function rpcAs(db: Database, owner: string): SyncRpc {
  return async (name, args) => {
    const parameters = rpc[name as keyof typeof rpc]
    if (!parameters || Object.keys(args).sort().join() !== parameters.map(([key]) => key).sort().join()) throw new Error(`Unexpected vault RPC ${name}`)
    const values = parameters.map(([key, type]) => type === 'jsonb' && args[key] !== null ? JSON.stringify(args[key]) : args[key])
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
const credential = (origin: string, account: string, password: string): SyncValue => ({ origin, name: '', account, accountSecret: false, password, fields: [], grants: [], sites: [] })
const ready = (view: SyncView) => { if (view.state !== 'ready') throw new Error(`expected ready, got ${view.state}`); return view }
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
      expect(await laptop.refresh()).toMatchObject({ state: 'joining' })
      expect(ready(await mac.refresh()).requests).toEqual([expect.objectContaining({ deviceId: laptopId, label: 'Laptop', stage: 'new' })])
      expect(ready(await mac.challenge(laptopId)).requests[0].stage).toBe('waiting')
      const shown = await laptop.refresh() as Extract<SyncView, { state: 'joining' }>
      expect(shown.code).toMatch(/^\d{6}$/)
      const request = ready(await mac.refresh()).requests[0]
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
      expect(ready(await mac.remove(laptopId)).devices.map(device => device.deviceId)).toEqual([macId])
      expect((await db.query<{ key_epoch: number }>('SELECT key_epoch FROM identity.password_vault_heads WHERE owner_user_id=$1', [owner])).rows[0]!.key_epoch).toBe(2)
      await macVault.save(github, credential('https://github.com', 'me@example.com', 'canary-after-removal'))
      expect(await laptop.refresh()).toMatchObject({ state: 'joining' })
      expect(laptopVault.items.get(github)?.password).toBe('canary-rotated-password')
      await laptopVault.save(laptopOnly, credential('https://laptop.example.com', 'me', 'canary-local-only'))
      await mac.refresh()
      expect(macVault.items.get(laptopOnly)?.password).toBe('canary-laptop')
      // The Mac's request list now shows the laptop asking again; ignoring it leaves the vault as it is.
      expect(ready(await mac.refresh()).requests).toEqual([expect.objectContaining({ deviceId: laptopId, stage: 'new' })])

      // The recovery code: the Mac makes one; a third device that no device approves joins with the account and the code.
      const { code } = await mac.createRecovery()
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/)
      expect(ready(await mac.refresh()).recovery).toBe('set')
      const phoneId = randomUUID(), phoneVault = new MemoryVault()
      await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,machine_id) VALUES($1,$2,'Spare','h','darwin',$3)`, [phoneId, owner, `machine-${phoneId}`])
      const spare = engine(phoneId, phoneVault)
      expect(await spare.refresh()).toMatchObject({ state: 'joining', recovery: true })
      await expect(spare.recover(code.replace('0', 'O').toLowerCase().replaceAll('-', ' '))).resolves.toBeTruthy()
      expect(phoneVault.items.get(github)?.password).toBe('canary-after-removal')
      // Used up: the same code opens nothing any more, and the spare device holds a fresh one.
      const other = new MemoryVault(), otherId = randomUUID()
      await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,machine_id) VALUES($1,$2,'Other','h','darwin',$3)`, [otherId, owner, `machine-${otherId}`])
      const third = engine(otherId, other)
      await third.refresh()
      await expect(third.recover(code)).rejects.toMatchObject({ code: 'NOT_MEMBER' })
      expect(ready(await spare.refresh()).recovery).toBe('set')
      // Removing a device keeps the current code working (re-sealed); dropping the code makes it open nothing.
      expect(ready(await mac.remove(phoneId)).recovery).toBe('set')
      await mac.removeRecovery()
      expect(ready(await mac.refresh()).recovery).toBe('unset')
      mac.dispose(); laptop.dispose(); spare.dispose(); third.dispose()
    } finally { await db.query('ROLLBACK') }
  }))

  it('a cloud that rewrites a round cannot make the codes agree; moved requests and reinstalls start a new round', async () => withContractDatabase(async db => {
    await db.query('BEGIN')
    try {
      const owner = randomUUID(), [macId, laptopId] = [randomUUID(), randomUUID()]
      await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,now(),now())`, [owner, `${owner}@vault.invalid`])
      for (const id of [macId, laptopId]) await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,machine_id)
        VALUES($1,$2,$3,'h','darwin',$4)`, [id, owner, id === macId ? 'Mac' : 'Laptop', `machine-${id}`])
      const engine = (deviceId: string, vault: MemoryVault, folder = deviceId) =>
        (vault.sync = new VaultSync({ root: join(root, folder), ownerId: owner, deviceId, keys, rpc: rpcAs(db, owner), vault, changed() {} }))
      const row = async () => (await db.query<{ public_key: string; commitment: string | null; approver_nonce: string | null; device_nonce: string | null; status: string }>(
        'SELECT public_key, commitment, approver_nonce, device_nonce, status FROM identity.password_vault_devices WHERE owner_user_id=$1 AND device_id=$2', [owner, laptopId])).rows[0]
      const macVault = new MemoryVault(), laptopVault = new MemoryVault()
      const mac = engine(macId, macVault), laptop = engine(laptopId, laptopVault)

      // No passwords anywhere: no vault, nothing to ask. The first entry creates it.
      expect(await mac.refresh()).toEqual({ state: 'off' })
      expect(await laptop.refresh()).toEqual({ state: 'off' })
      expect((await db.query('SELECT 1 FROM identity.password_vault_heads WHERE owner_user_id=$1', [owner])).rows).toHaveLength(0)
      macVault.items.set(randomUUID(), credential('https://github.com', 'me@example.com', 'canary-github'))
      expect(await mac.refresh()).toMatchObject({ state: 'ready' })
      expect(await mac.poll()).toBe(false)

      // A round: the laptop asks, the Mac posts its nonce, the laptop reveals and shows a code.
      expect(await laptop.refresh()).toMatchObject({ state: 'joining' })
      expect(await mac.poll()).toBe(true)
      expect(ready(await mac.challenge(laptopId)).requests[0]!.stage).toBe('waiting')
      expect((await laptop.refresh() as Extract<SyncView, { state: 'joining' }>).code).toMatch(/^\d{6}$/)
      const first = await row()

      // The cloud swaps the approver nonce after the laptop revealed (it could pick one that makes the codes agree):
      // the laptop shows no code from it and starts over with a fresh commitment.
      await db.query('UPDATE identity.password_vault_devices SET approver_nonce=$3 WHERE owner_user_id=$1 AND device_id=$2', [owner, laptopId, crypto.randomNonce()])
      expect(await laptop.refresh()).toEqual({ state: 'joining', recovery: false })
      expect(await row()).toMatchObject({ approver_nonce: null, device_nonce: null, status: 'pending' })
      expect((await row())!.commitment).not.toBe(first!.commitment)
      expect(ready(await mac.refresh()).requests[0]!.stage).toBe('new')

      // The cloud swaps the asking key after the Mac posted its nonce, with a commitment made for it afterwards: mismatch.
      expect(ready(await mac.challenge(laptopId)).requests[0]!.stage).toBe('waiting')
      await laptop.refresh()
      const fake = await crypto.createDeviceKeyPair(), fakeNonce = crypto.randomNonce()
      await db.query('UPDATE identity.password_vault_devices SET public_key=$3, commitment=$4, device_nonce=$5 WHERE owner_user_id=$1 AND device_id=$2',
        [owner, laptopId, fake.publicKey, crypto.commitment(fake.publicKey, fakeNonce), fakeNonce])
      expect(ready(await mac.refresh()).requests[0]!.stage).toBe('mismatch')
      await expect(mac.approve(laptopId)).rejects.toMatchObject({ code: 'STATE' })
      // The laptop sees a key that is not its own and asks again.
      expect(await laptop.refresh()).toMatchObject({ state: 'joining' })
      expect((await row())!.public_key).not.toBe(fake.publicKey)

      // Opened before a restart: the nonce is gone, but the request is still this device's to open (another device's
      // would show as elsewhere). Opening it drops the old round, the laptop asks again at once, and this device takes it.
      await mac.challenge(laptopId)
      mac.dispose()
      const restarted = engine(macId, macVault)
      expect(ready(await restarted.refresh()).requests[0]!.stage).toBe('new')
      await restarted.challenge(laptopId)
      expect(await row()).toBeUndefined()
      expect(await laptop.refresh()).toMatchObject({ state: 'joining' })
      expect(ready(await restarted.challenge(laptopId)).requests[0]!.stage).toBe('waiting')
      const shown = await laptop.refresh() as Extract<SyncView, { state: 'joining' }>
      expect(ready(await restarted.refresh()).requests[0]).toMatchObject({ stage: 'compare', code: shown.code })
      await restarted.approve(laptopId)
      expect(await laptop.refresh()).toMatchObject({ state: 'ready' })

      // Reinstalled: same device, its key gone. It asks again instead of being stuck, and the vault is re-keyed.
      laptop.dispose()
      const reinstalled = engine(laptopId, new MemoryVault(), `${laptopId}-reinstalled`)
      expect(await reinstalled.refresh()).toMatchObject({ state: 'joining' })
      expect(ready(await restarted.refresh()).requests).toEqual([expect.objectContaining({ deviceId: laptopId, stage: 'new' })])
      expect((await db.query<{ key_epoch: number }>('SELECT key_epoch FROM identity.password_vault_heads WHERE owner_user_id=$1', [owner])).rows[0]!.key_epoch).toBe(2)
      // 「不是我」 sticks: the device stays refused and asks nothing by itself; asked again on purpose, it is a new request.
      await restarted.reject(laptopId)
      expect(await reinstalled.refresh()).toEqual({ state: 'refused', recovery: false })
      expect(await reinstalled.refresh()).toEqual({ state: 'refused', recovery: false })
      expect(ready(await restarted.refresh()).requests).toEqual([])
      expect(await reinstalled.askAgain()).toMatchObject({ state: 'joining' })
      expect(ready(await restarted.refresh()).requests).toEqual([expect.objectContaining({ deviceId: laptopId, stage: 'new' })])
      restarted.dispose(); reinstalled.dispose()
    } finally { await db.query('ROLLBACK') }
  }))

  it('a cloud acting on its own can neither slip in a device nor hand out a key of its own', async () => withContractDatabase(async db => {
    await db.query('BEGIN')
    try {
      const owner = randomUUID(), [macId, laptopId, cloudId, spareId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
      await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,now(),now())`, [owner, `${owner}@vault.invalid`])
      for (const id of [macId, laptopId, cloudId, spareId]) await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,machine_id)
        VALUES($1,$2,$3,'h','darwin',$4)`, [id, owner, id.slice(0, 8), `machine-${id}`])
      const engine = (deviceId: string, vault: MemoryVault, folder = deviceId) =>
        (vault.sync = new VaultSync({ root: join(root, folder), ownerId: owner, deviceId, keys, rpc: rpcAs(db, owner), vault, changed() {} }))
      const macVault = new MemoryVault(), laptopVault = new MemoryVault()
      macVault.items.set(randomUUID(), credential('https://github.com', 'me@example.com', 'canary-github'))
      const mac = engine(macId, macVault), laptop = engine(laptopId, laptopVault)
      await mac.refresh(); await laptop.refresh(); await mac.refresh(); await mac.challenge(laptopId); await laptop.refresh(); await mac.approve(laptopId)
      expect(await laptop.refresh()).toMatchObject({ state: 'ready' })
      const head = async () => parseSnapshot((await db.query<{ body: string }>('SELECT body FROM identity.password_vault_log WHERE owner_user_id=$1 ORDER BY seq DESC LIMIT 1', [owner])).rows[0]!.body)!
      expect((await head()).members.map(member => member.id).sort()).toEqual([macId, laptopId].sort())
      const cloud = await crypto.createDeviceKeyPair()

      // An entry that adds the cloud's device under the Mac's name: both devices refuse the whole state.
      const signed = await head()
      const forged = await writeEntry(owner, signed, { ...signed, members: [...signed.members, { id: cloudId, key: cloud.publicKey, scope: 'full' }] }, { id: macId, pair: cloud })
      await db.query('INSERT INTO identity.password_vault_log(owner_user_id,seq,body,signature) VALUES($1,$2,$3,$4)', [owner, forged.entry.seq, forged.entry.body, forged.entry.signature])
      await expect(mac.refresh()).rejects.toMatchObject({ code: 'INVALID' })
      await expect(laptop.refresh()).rejects.toMatchObject({ code: 'INVALID' })
      await db.query('DELETE FROM identity.password_vault_log WHERE owner_user_id=$1 AND seq=$2', [owner, forged.entry.seq])

      // A device the cloud approved by itself, without an entry: not listed, and a re-key never seals the new key to it.
      await db.query(`INSERT INTO identity.password_vault_devices(owner_user_id,device_id,public_key,status,scope,approved_at) VALUES($1,$2,$3,'approved','full',now())`, [owner, cloudId, cloud.publicKey])
      expect(ready(await mac.refresh()).devices.map(device => device.deviceId).sort()).toEqual([macId, laptopId].sort())
      await expect(mac.remove(laptopId)).rejects.toMatchObject({ code: 'INVALID' })
      expect((await db.query('SELECT 1 FROM identity.password_vault_shares WHERE owner_user_id=$1 AND device_id=$2', [owner, cloudId])).rows).toHaveLength(0)
      await db.query('DELETE FROM identity.password_vault_devices WHERE owner_user_id=$1 AND device_id=$2', [owner, cloudId])

      // A vault key of the cloud's own, sealed to the laptop: the laptop will not use it.
      const share = (await db.query<{ sealed: string }>('SELECT sealed FROM identity.password_vault_shares WHERE owner_user_id=$1 AND device_id=$2 AND item_id IS NULL', [owner, laptopId])).rows[0]!
      const laptopKey = (await db.query<{ public_key: string }>('SELECT public_key FROM identity.password_vault_devices WHERE owner_user_id=$1 AND device_id=$2', [owner, laptopId])).rows[0]!.public_key
      await db.query('UPDATE identity.password_vault_shares SET sealed=$3 WHERE owner_user_id=$1 AND device_id=$2 AND item_id IS NULL', [owner, laptopId, await crypto.sealVaultKey(laptopKey, 1, crypto.randomKey())])
      const restarted = engine(laptopId, laptopVault)
      await expect(restarted.refresh()).rejects.toMatchObject({ code: 'INVALID' })
      await expect(laptopVault.save(randomUUID(), credential('https://new.example.com', 'me', 'canary-new'))).rejects.toThrow()
      // The refused edit schedules a pull; let it finish before the cloud is touched again.
      await settle(); await restarted.refresh().catch(() => {})
      await db.query('UPDATE identity.password_vault_shares SET sealed=$3 WHERE owner_user_id=$1 AND device_id=$2 AND item_id IS NULL', [owner, laptopId, share.sealed])
      expect(await restarted.refresh()).toMatchObject({ state: 'ready' })

      // The cloud knows the recovery code's public key and can seal any key to it: a device recovering with the code
      // checks that key against what the devices signed, and does not join.
      const { code } = await mac.createRecovery()
      const recoveryKey = (await db.query<{ recovery_public_key: string; key_epoch: number }>('SELECT recovery_public_key, key_epoch FROM identity.password_vault_heads WHERE owner_user_id=$1', [owner])).rows[0]!
      await db.query('UPDATE identity.password_vault_heads SET recovery_sealed=$2 WHERE owner_user_id=$1', [owner, await crypto.sealVaultKey(recoveryKey.recovery_public_key, recoveryKey.key_epoch, crypto.randomKey())])
      const spare = engine(spareId, new MemoryVault())
      await spare.refresh()
      await expect(spare.recover(code)).rejects.toMatchObject({ code: 'INVALID' })
      expect((await db.query(`SELECT 1 FROM identity.password_vault_devices WHERE owner_user_id=$1 AND device_id=$2 AND status='approved'`, [owner, spareId])).rows).toHaveLength(0)
      mac.dispose(); laptop.dispose(); restarted.dispose(); spare.dispose()
    } finally { await db.query('ROLLBACK') }
  }))
})
