import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { VaultError, type VaultKeyProtector } from './contracts'
import type { SyncChange, SyncValue } from './management'
import * as c from './sync-crypto'
import { RECOVERY_SIGNER, parseSnapshot, snapshotText, verifyLog, writeEntry, type Member, type MemberSnapshot } from './sync-members'

/**
 * End-to-end encrypted sync of one account's vault across its devices (SYNC.md). The cloud holds ciphertext only; this
 * engine holds the device key, opens the vault key from its share, and moves items between the cloud and the local vault.
 * Local writes publish here first (inside the vault's queue), so publish never waits for refresh; refresh applies pulled
 * items through the vault's own queue.
 */
export type SyncCode = 'STALE' | 'NOT_MEMBER' | 'STATE' | 'OFFLINE' | 'INVALID'
export class SyncError extends Error { constructor(readonly code: SyncCode) { super(code); this.name = 'SyncError' } }
export type SyncRpc = (name: string, args: Record<string, unknown>) => Promise<unknown>
/** The local vault as the engine sees it; both calls run in the vault's queue under the trusted person context. */
export interface SyncVault {
  syncExport(): Promise<(SyncValue & { id: string })[]>
  syncApply(changes: { id: string; value?: SyncValue }[]): Promise<void>
}
export interface SyncDevice { deviceId: string; label: string; platform: string; current: boolean }
/** new: nobody opened it yet · elsewhere: opened on another device (or before this app restarted) · waiting: our nonce is
 * posted, the device has not revealed yet · compare: both screens show `code` · mismatch: the device broke its commitment. */
export interface SyncRequest extends SyncDevice { stage: 'new' | 'elsewhere' | 'waiting' | 'compare' | 'mismatch'; code?: string }
export type SyncView =
  | { state: 'off' }
  /** recovery: a recovery code exists, so this device can join with it instead of another device's approval. */
  | { state: 'joining'; code?: string; recovery?: boolean }
  | { state: 'blocked'; recovery?: boolean }
  /** A device that has the passwords answered 「不是我」 for this device's key; it asks again only when the person says so. */
  | { state: 'refused'; recovery?: boolean }
  /** recovery: set · unset · ask (unset, and this device has not offered it yet) */
  | { state: 'ready'; devices: SyncDevice[]; requests: SyncRequest[]; recovery: 'set' | 'unset' | 'ask' }

const b64 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
/** nonce / pinned / pinnedKey: this device's join round (its nonce, and the approver's nonce and key the code covers).
 * trusted: the newest membership entry this device verified; kept only while it is a member. pending: an entry it is
 * writing while not a member yet (creating the vault, recovering), from which it may start trusting. */
const fileSchema = z.strictObject({ schema: z.literal(2), deviceId: z.string().min(1), publicKey: b64, secret: z.string(),
  nonce: b64.optional(), pinned: b64.optional(), pinnedKey: b64.optional(), trusted: z.string().optional(), pending: z.string().optional(),
  revision: z.string().regex(/^\d+$/), versions: z.record(z.string(), z.string().regex(/^\d+$/)), merged: z.boolean(),
  recoveryAsked: z.boolean().optional() })
type DeviceFile = z.infer<typeof fileSchema>
const remoteDevice = z.object({ deviceId: z.string(), label: z.string().nullable(), platform: z.string().nullable(), hostKind: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'refused']), scope: z.enum(['full', 'granted']).nullable(), publicKey: b64, commitment: z.string().nullable(),
  approverDeviceId: z.string().nullable(), approverNonce: b64.nullable(), deviceNonce: b64.nullable() })
const remoteItem = z.object({ itemId: z.string(), version: z.string(), epoch: z.number(), wrappedKey: z.string().nullable(),
  ciphertext: z.string().nullable(), deleted: z.boolean(), revision: z.string() })
const remoteState = z.union([z.object({ initialized: z.literal(false) }), z.object({ initialized: z.literal(true), epoch: z.number().int(),
  revision: z.string(), rotationRequired: z.boolean(), recovery: z.boolean(), recoveryPublicKey: b64.nullable(), devices: z.array(remoteDevice),
  log: z.array(z.object({ seq: z.number().int(), body: z.string(), signature: z.string(), attestation: z.string().nullable() })),
  shares: z.array(z.object({ itemId: z.string().nullable(), epoch: z.number(), sealed: z.string() })), items: z.array(remoteItem) })])
type RemoteState = Extract<z.infer<typeof remoteState>, { initialized: true }>
type RemoteItem = z.infer<typeof remoteItem>
// Keys added later default here, so an entry written before they existed compares equal to its re-saved self.
const valueSchema = z.strictObject({ origin: z.string(), name: z.string().default(''), account: z.string(), accountSecret: z.boolean().default(false), password: z.string(),
  fields: z.array(z.strictObject({ id: z.string(), name: z.string(), value: z.string(), secret: z.boolean().default(true) })),
  grants: z.array(z.strictObject({ subject: z.string(), level: z.enum(['read', 'write']) })), sites: z.array(z.string()).default([]) })
const sameValue = (a: SyncValue, b: SyncValue) => JSON.stringify(valueSchema.parse(a)) === JSON.stringify(valueSchema.parse(b))

/** Sync state lives beside the account's vault root, never inside it: the vault requires its root to be empty
 * before it is first created, and treats anything else there as damage. */
export const syncDirectory = (vaultDirectory: string, ownerId: string) => join(vaultDirectory, 'sync', ownerId)
export interface VaultSyncOptions {
  root: string; ownerId: string; deviceId: string; keys: VaultKeyProtector; rpc: SyncRpc; vault: SyncVault
  /** The person approved a device; scope by the device kind (pending owner decision 2: every device gets the whole vault). */
  scopeFor?(device: { hostKind: string | null; platform: string | null }): 'full' | 'granted'
  changed(): void
}
export class VaultSync {
  readonly #o: VaultSyncOptions
  #file?: DeviceFile
  #secret?: Buffer
  #vaultKey?: { epoch: number; key: Buffer }
  #state?: RemoteState
  #view: SyncView = { state: 'off' }
  #queue: Promise<unknown> = Promise.resolve()
  #writes: Promise<unknown> = Promise.resolve()
  /** Per requesting device: the nonce this device posted as approver, and the key and commitment it saw before posting.
   * Lost on restart: the request then shows as elsewhere, and opening it again starts a new round. */
  readonly #challenges = new Map<string, { nonce: string; publicKey: string; commitment: string }>()
  /** The head revision of the last pull: polling compares against it and pulls only when something was written. */
  #seen?: string
  constructor(options: VaultSyncOptions) { this.#o = options }
  view(): SyncView { return this.#view }
  /** Cheap check: has anything been written for this account since the last pull? */
  async poll(): Promise<boolean> {
    const file = await this.load()
    return String(await this.call('password_vault_revision', { p_device_id: file.deviceId })) !== this.#seen
  }
  dispose() { this.#secret?.fill(0); this.#secret = undefined; this.#vaultKey?.key.fill(0); this.#vaultKey = undefined }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work); this.#queue = next.catch(() => undefined); return next
  }
  private async call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    try { return await this.#o.rpc(name, args) as T }
    catch (error) { throw toSyncError(error) }
  }
  private get path() { return join(this.#o.root, 'sync-device.json') }
  private binding(deviceId: string) { return JSON.stringify(['gugu-vault-sync-device', 1, this.#o.ownerId, deviceId]) }
  private async load(): Promise<DeviceFile> {
    if (this.#file) return this.#file
    let raw: string | undefined
    try { raw = await readFile(this.path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new VaultError('STORAGE_FAILED') }
    const parsed = raw ? fileSchema.safeParse(JSON.parse(raw)) : undefined
    if (parsed?.success && parsed.data.deviceId === this.#o.deviceId) {
      this.#file = parsed.data
      this.#secret = await this.#o.keys.unwrap(parsed.data.secret, this.binding(parsed.data.deviceId))
      return this.#file
    }
    // No key yet (or one from another device id): a fresh key pair, and the device asks to join again.
    const pair = await c.createDeviceKeyPair()
    try {
      this.#file = { schema: 2, deviceId: this.#o.deviceId, publicKey: pair.publicKey, secret: await this.#o.keys.wrap(pair.secretKey, this.binding(this.#o.deviceId)),
        revision: '0', versions: {}, merged: false }
      this.#secret = Buffer.from(pair.secretKey)
      await this.save()
      return this.#file
    } finally { pair.secretKey.fill(0) }
  }
  private save(): Promise<void> {
    const write = this.#writes.then(async () => {
      if (!this.#file) return
      await mkdir(this.#o.root, { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(this.#file), { mode: 0o600 })
      await rename(temporary, this.path)
    })
    this.#writes = write.catch(() => undefined)
    return write
  }
  private pair(file: DeviceFile): c.DeviceKeyPair {
    if (!this.#secret) throw new VaultError('LOCKED')
    return { publicKey: file.publicKey, secretKey: this.#secret }
  }
  private signer(file: DeviceFile) { return { id: file.deviceId, pair: this.pair(file) } }
  private trusted(file: DeviceFile): MemberSnapshot | undefined { return file.trusted ? parseSnapshot(file.trusted) : undefined }
  private member(file: DeviceFile): MemberSnapshot {
    const trusted = this.trusted(file)
    if (!trusted) throw new SyncError('NOT_MEMBER')
    return trusted
  }
  private async openVaultKey(state: RemoteState, file: DeviceFile): Promise<Buffer | undefined> {
    if (this.#vaultKey?.epoch === state.epoch) return this.#vaultKey.key
    const share = state.shares.find(entry => entry.itemId === null && entry.epoch === state.epoch)
    if (!share) return undefined
    const key = await c.openVaultKey(this.pair(file), state.epoch, share.sealed)
    // Only the key the devices signed for: one the cloud made up would hand it everything written with it.
    if (c.keyHash(this.#o.ownerId, state.epoch, key) !== this.trusted(file)?.keyHash) { key.fill(0); throw new SyncError('INVALID') }
    this.#vaultKey?.key.fill(0); this.#vaultKey = { epoch: state.epoch, key }
    return key
  }
  private seal(vaultKey: Buffer, epoch: number, id: string, version: number, value: SyncValue, itemKey = c.randomKey()) {
    try {
      return { wrappedKey: c.boxed(vaultKey, itemKey, c.aad('item-key', this.#o.ownerId, id, epoch)),
        ciphertext: c.boxed(itemKey, Buffer.from(JSON.stringify(value), 'utf8'), c.aad('item', this.#o.ownerId, id, version)) }
    } finally { itemKey.fill(0) }
  }
  private open(vaultKey: Buffer, item: RemoteItem): SyncValue {
    const itemKey = c.unboxed(vaultKey, item.wrappedKey!, c.aad('item-key', this.#o.ownerId, item.itemId, item.epoch))
    try {
      const bytes = c.unboxed(itemKey, item.ciphertext!, c.aad('item', this.#o.ownerId, item.itemId, Number(item.version)))
      try {
        const parsed = valueSchema.safeParse(JSON.parse(bytes.toString('utf8')))
        if (!parsed.success) throw new VaultError('DATA_DAMAGED')
        return parsed.data
      } finally { bytes.fill(0) }
    } finally { itemKey.fill(0) }
  }

  /** Pull, join, merge and apply. Safe to call often; serialized. */
  refresh(): Promise<SyncView> {
    return this.serial(async () => {
      try { this.#view = await this.step() }
      catch (error) { if (!(error instanceof SyncError) || error.code !== 'OFFLINE') this.#view = { state: 'off' }; throw error }
      finally { this.#o.changed() }
      return this.#view
    })
  }
  private async fetch(file: DeviceFile, since: string, logSince = this.trusted(file)?.seq ?? 0) {
    const parsed = remoteState.safeParse(await this.call('password_vault_state', { p_device_id: file.deviceId, p_since: Number(since), p_log_since: logSince }))
    if (!parsed.success) throw new SyncError('INVALID')
    this.#seen = parsed.data.initialized ? parsed.data.revision : '0'
    if (parsed.data.initialized) await this.verify(file, parsed.data)
    return parsed.data
  }
  /** While this device is a member, the cloud's word on who holds the key and which key is current counts only as far
   * as the signed log agrees. Not a member (any more): nothing to trust; it starts again from the entry that admits it. */
  private async verify(file: DeviceFile, state: RemoteState) {
    const me = state.devices.find(device => device.deviceId === file.deviceId)
    if (me?.status !== 'approved' || me.publicKey !== file.publicKey) {
      if (file.trusted) { delete file.trusted; await this.save() }
      return
    }
    const trusted = this.trusted(file)
    const head = await verifyLog(this.#o.ownerId, trusted ? state.log.filter(entry => entry.seq > trusted.seq) : state.log,
      trusted ? { trusted } : { pending: file.pending, approverKey: file.pinnedKey, self: { id: file.deviceId, key: file.publicKey } })
    if (!head || head.epoch !== state.epoch || (head.recovery !== null) !== state.recovery
      || !head.members.some(member => member.id === file.deviceId && member.key === file.publicKey)) throw new SyncError('INVALID')
    const text = snapshotText(head)
    if (file.trusted === text) return
    file.trusted = text
    delete file.pending; delete file.nonce; delete file.pinned; delete file.pinnedKey
    await this.save()
  }
  private async step(): Promise<SyncView> {
    const file = await this.load()
    let state = await this.fetch(file, file.revision)
    if (!state.initialized) {
      // No passwords anywhere yet: nothing to sync and nobody to ask. The device with the first entry creates the vault;
      // the second of two racing first devices then asks to join.
      if (!(await this.#o.vault.syncExport()).length) return { state: 'off' }
      const vaultKey = c.randomKey()
      try {
        const { entry } = await writeEntry(this.#o.ownerId, undefined, { epoch: 1, keyHash: c.keyHash(this.#o.ownerId, 1, vaultKey), recovery: null,
          members: [{ id: file.deviceId, key: file.publicKey, scope: 'full' }] }, this.signer(file))
        file.pending = entry.body; await this.save()
        await this.call('password_vault_initialize', { p_device_id: file.deviceId, p_public_key: file.publicKey,
          p_sealed_key: await c.sealVaultKey(file.publicKey, 1, vaultKey), p_entry: entry })
        Object.assign(file, { revision: '0', versions: {}, merged: false }); await this.save()
      } catch (error) {
        if (!(error instanceof SyncError) || error.code !== 'STATE') throw error
        delete file.pending; await this.save()
      } finally { vaultKey.fill(0) }
      state = await this.fetch(file, '0')
      if (!state.initialized) throw new SyncError('STATE')
    }
    const me = state.devices.find(device => device.deviceId === file.deviceId)
    if (me?.status !== 'approved' || me.publicKey !== file.publicKey) {
      // Removed elsewhere, never joined, or approved under a key this device no longer has (reinstalled): edits stay
      // local and merge when this device joins again; a lost key simply asks again.
      if (file.merged) { Object.assign(file, { merged: false, revision: '0', versions: {} }); this.#state = undefined; await this.save() }
      if (me?.status === 'refused' && me.publicKey === file.publicKey) return { state: 'refused', recovery: state.recovery }
      return { ...await this.join(file, state, me?.status === 'pending' ? me : undefined), recovery: state.recovery }
    }
    const vaultKey = await this.openVaultKey(state, file)
    if (!vaultKey) return { state: 'joining' }
    // A brand-new member pulls everything once, then only what changed.
    if (!file.merged && file.revision !== '0') { Object.assign(file, { revision: '0' }); state = await this.fetch(file, '0') as RemoteState }
    this.#state = state
    await this.apply(file, state, vaultKey)
    if (!file.merged) await this.merge(file, state, vaultKey)
    if (state.rotationRequired && me.scope === 'full') { await this.rotate([]); this.#state = state = await this.fetch(file, file.revision) as RemoteState }
    return this.ready(file, state)
  }
  private async join(file: DeviceFile, state: RemoteState, me: z.infer<typeof remoteDevice> | undefined): Promise<Extract<SyncView, { state: 'joining' | 'blocked' }>> {
    if (!me || me.publicKey !== file.publicKey) {
      file.nonce = c.randomNonce(); delete file.pinned; delete file.pinnedKey; await this.save()
      try { await this.call('password_vault_request', { p_device_id: file.deviceId, p_public_key: file.publicKey, p_commitment: c.commitment(file.publicKey, file.nonce) }) }
      catch (error) { if (error instanceof SyncError && error.code === 'STATE') return { state: 'blocked' }; throw error }
      return { state: 'joining' }
    }
    if (!file.nonce) {
      // The nonce behind this request is gone (reinstalled store): ask again with a new one.
      await this.call('password_vault_dismiss', { p_caller_device_id: file.deviceId, p_device_id: file.deviceId })
      return this.join(file, state, undefined)
    }
    if (!me.approverNonce && !me.deviceNonce && !file.pinned) return { state: 'joining' }
    // Our nonce goes out once, for one approver nonce, and the code is computed from that one only. Were the code taken
    // from whatever approver nonce the cloud shows later, a cloud that has seen our nonce could pick one that makes the
    // two screens agree on its own key. Anything else than the pinned round starts a new round with a fresh nonce.
    // The approver's key is pinned with its nonce: the code covers it, and once approved this device trusts the
    // membership entry that key signed.
    if (!file.pinned && !me.deviceNonce && me.approverNonce) {
      const approver = state.devices.find(device => device.deviceId === me.approverDeviceId && device.status === 'approved')
      if (!approver) return { state: 'joining' }
      file.pinned = me.approverNonce; file.pinnedKey = approver.publicKey; await this.save()
    }
    if (!file.pinned || !file.pinnedKey || me.approverNonce !== file.pinned || me.deviceNonce && me.deviceNonce !== file.nonce) return this.join(file, state, undefined)
    if (!me.deviceNonce) await this.call('password_vault_reveal', { p_device_id: file.deviceId, p_device_nonce: file.nonce })
    return { state: 'joining', code: c.shortCode(file.publicKey, file.nonce, file.pinned, file.pinnedKey) }
  }
  private async apply(file: DeviceFile, state: RemoteState, vaultKey: Buffer) {
    const changes: { id: string; value?: SyncValue }[] = []
    for (const item of state.items) {
      if (file.versions[item.itemId] === item.version) continue
      changes.push(item.deleted ? { id: item.itemId } : { id: item.itemId, value: this.open(vaultKey, item) })
    }
    await this.#o.vault.syncApply(changes)
    for (const item of state.items) file.versions[item.itemId] = item.version
    file.revision = maxRevision(file.revision, state.revision)
    await this.save()
  }
  /** First sync of a device that already had a local vault: the same site, account and name become one entry (two
   * API keys of one site without an account stay apart by name). */
  private async merge(file: DeviceFile, state: RemoteState, vaultKey: Buffer) {
    const remote = new Map<string, { id: string; value: SyncValue }>()
    const twinKey = (value: SyncValue) => JSON.stringify([value.origin, value.account, value.account ? '' : value.name ?? ''])
    for (const item of state.items) if (!item.deleted) { const value = this.open(vaultKey, item); remote.set(twinKey(value), { id: item.itemId, value }) }
    const local = await this.#o.vault.syncExport(), dropped: { id: string }[] = []
    for (const entry of local) {
      if (file.versions[entry.id]) continue
      const { id, ...value } = entry, twin = remote.get(twinKey(value))
      if (twin && twin.id !== id) {
        const grants = [...new Map([...twin.value.grants, ...value.grants].map(grant => [grant.subject, grant] as const)).values()]
        if (grants.length !== twin.value.grants.length) await this.publishSave(file, state.epoch, vaultKey, twin.id, { ...twin.value, grants })
        dropped.push({ id })
      } else if (!twin) await this.publishSave(file, state.epoch, vaultKey, id, value)
    }
    await this.#o.vault.syncApply(dropped)
    file.merged = true; await this.save()
  }
  private ready(file: DeviceFile, state: RemoteState): SyncView {
    const view = (device: z.infer<typeof remoteDevice>): SyncDevice => ({ deviceId: device.deviceId, label: device.label ?? '', platform: device.platform ?? '', current: device.deviceId === file.deviceId })
    const requests = state.devices.filter(device => device.status === 'pending').map((device): SyncRequest => {
      const mine = this.#challenges.get(device.deviceId)
      if (!device.approverNonce) return { ...view(device), stage: 'new' }
      // Opened by this device before a restart (its nonce is gone): still ours to open again, not another device's.
      if (!mine || device.approverNonce !== mine.nonce) return { ...view(device), stage: device.approverDeviceId === file.deviceId ? 'new' : 'elsewhere' }
      if (!this.kept(device, mine)) return { ...view(device), stage: 'mismatch' }
      if (!device.deviceNonce) return { ...view(device), stage: 'waiting' }
      return { ...view(device), stage: 'compare', code: c.shortCode(device.publicKey, device.deviceNonce, mine.nonce, file.publicKey) }
    })
    const recovery = state.recovery ? 'set' : file.recoveryAsked ? 'unset' : 'ask'
    const members = this.trusted(file)?.members ?? []
    const signed = (device: z.infer<typeof remoteDevice>) => members.some(member => member.id === device.deviceId && member.key === device.publicKey)
    return { state: 'ready', devices: state.devices.filter(device => device.status === 'approved' && signed(device)).map(view), requests, recovery }
  }

  /** The requesting device committed to its key and nonce before seeing ours: the key and commitment we saw before posting
   * our nonce must still be the ones shown, and its nonce, once revealed, must open that commitment. */
  private kept(device: z.infer<typeof remoteDevice>, mine: { publicKey: string; commitment: string }) {
    return device.publicKey === mine.publicKey && device.commitment === mine.commitment
      && (!device.deviceNonce || c.verifyCommitment(device.publicKey, device.deviceNonce, mine.commitment))
  }
  /** The person is at this device while a request waits: post our nonce so both screens show the code. A request opened
   * elsewhere (another device, or this one before a restart) is dropped instead; the device asks again at once with a
   * fresh nonce, and the next open here takes it. */
  challenge(deviceId: string): Promise<SyncView> {
    return this.serial(async () => {
      const file = await this.load(), state = await this.fetch(file, file.revision)
      const device = state.initialized ? state.devices.find(entry => entry.deviceId === deviceId && entry.status === 'pending') : undefined
      if (!device?.commitment) throw new SyncError('STATE')
      if (this.#challenges.get(deviceId)?.nonce === device.approverNonce) return
      if (device.approverNonce) {
        this.#challenges.delete(deviceId)
        await this.call('password_vault_dismiss', { p_caller_device_id: file.deviceId, p_device_id: deviceId })
        return
      }
      const nonce = c.randomNonce()
      await this.call('password_vault_challenge', { p_approver_device_id: file.deviceId, p_device_id: deviceId, p_approver_nonce: nonce })
      this.#challenges.set(deviceId, { nonce, publicKey: device.publicKey, commitment: device.commitment })
    }).then(() => this.refresh())
  }
  /** The codes matched on both screens: seal the vault key to exactly the key whose code was shown. */
  approve(deviceId: string): Promise<SyncView> {
    return this.serial(async () => {
      const file = await this.load(), state = await this.fetch(file, file.revision)
      if (!state.initialized) throw new SyncError('STATE')
      const device = state.devices.find(entry => entry.deviceId === deviceId && entry.status === 'pending'), mine = this.#challenges.get(deviceId)
      if (!device || !mine || device.approverNonce !== mine.nonce || !device.deviceNonce || !this.kept(device, mine)) throw new SyncError('STATE')
      const vaultKey = await this.openVaultKey(state, file)
      if (!vaultKey) throw new SyncError('NOT_MEMBER')
      const trusted = this.member(file), scope = this.#o.scopeFor?.(device) ?? 'full'
      const shares = scope === 'full' ? [{ deviceId, sealed: await c.sealVaultKey(device.publicKey, state.epoch, vaultKey) }] : []
      const { entry } = await writeEntry(this.#o.ownerId, trusted, { epoch: trusted.epoch, keyHash: trusted.keyHash, recovery: trusted.recovery,
        members: [...trusted.members.filter(member => member.id !== deviceId), { id: deviceId, key: device.publicKey, scope }] }, this.signer(file))
      await this.call('password_vault_approve', { p_approver_device_id: file.deviceId, p_device_id: deviceId, p_public_key: device.publicKey,
        p_scope: scope, p_epoch: state.epoch, p_shares: shares, p_entry: entry })
      this.#challenges.delete(deviceId)
    }).then(() => this.refresh())
  }
  /** 「不是我」: the request stays refused for its key, so it does not come back by itself. */
  reject(deviceId: string): Promise<SyncView> {
    return this.serial(async () => {
      const file = await this.load()
      await this.call('password_vault_refuse', { p_caller_device_id: file.deviceId, p_device_id: deviceId })
      this.#challenges.delete(deviceId)
    }).then(() => this.refresh())
  }
  /** Refused, and the person asks again on purpose: a new device key makes a new request. */
  askAgain(): Promise<SyncView> {
    return this.serial(async () => {
      const file = await this.load(), pair = await c.createDeviceKeyPair()
      try {
        Object.assign(file, { publicKey: pair.publicKey, secret: await this.#o.keys.wrap(pair.secretKey, this.binding(file.deviceId)), merged: false, revision: '0', versions: {} })
        delete file.nonce; delete file.pinned; delete file.pinnedKey; delete file.trusted; delete file.pending
        this.#secret?.fill(0); this.#secret = Buffer.from(pair.secretKey)
        await this.save()
      } finally { pair.secretKey.fill(0) }
    }).then(() => this.refresh())
  }
  /** Remove a device and re-key, so it cannot read anything written afterwards. */
  remove(deviceId: string): Promise<SyncView> {
    return this.serial(() => this.rotate([deviceId])).then(() => this.refresh())
  }
  /** Generate the recovery code (or replace it: the old one stops opening anything). Returns the code, shown once. */
  createRecovery(): Promise<{ view: SyncView; code: string }> {
    let code = ''
    return this.serial(async () => {
      const file = await this.load(), state = await this.fetch(file, file.revision)
      if (!state.initialized) throw new SyncError('STATE')
      const vaultKey = await this.openVaultKey(state, file)
      if (!vaultKey) throw new SyncError('NOT_MEMBER')
      const trusted = this.member(file), next = c.recoveryCode(), keys = await c.recoveryKeys(next)
      try {
        if (trusted.recovery) await this.rotate([], { pair: keys.pair, verifier: keys.verifier })
        else {
          const { entry } = await writeEntry(this.#o.ownerId, trusted, { epoch: trusted.epoch, keyHash: trusted.keyHash, members: trusted.members,
            recovery: keys.pair.publicKey }, this.signer(file), keys.pair)
          await this.call('password_vault_set_recovery', { p_device_id: file.deviceId, p_epoch: state.epoch, p_public_key: keys.pair.publicKey,
            p_verifier: keys.verifier, p_sealed: await c.sealVaultKey(keys.pair.publicKey, state.epoch, vaultKey), p_entry: entry })
        }
      } finally { keys.pair.secretKey.fill(0) }
      file.recoveryAsked = true; await this.save()
      code = next
    }).then(async () => ({ view: await this.refresh(), code }))
  }
  /** Drop the recovery code; re-keying makes sure it opens nothing written before or after. */
  removeRecovery(): Promise<SyncView> {
    return this.serial(() => this.rotate([], 'drop')).then(() => this.refresh())
  }
  /** The person chose not to set a code now; it stays available under the device list. */
  skipRecovery(): Promise<SyncView> {
    return this.serial(async () => { const file = await this.load(); file.recoveryAsked = true; await this.save() }).then(() => this.refresh())
  }
  /** Every other device is gone: join with the account and the code. The code is used up, and a new one is issued. */
  recover(code: string): Promise<{ view: SyncView; code: string }> {
    return this.serial(async () => {
      const file = await this.load()
      let keys: Awaited<ReturnType<typeof c.recoveryKeys>>
      try { keys = await c.recoveryKeys(code) } catch { throw new SyncError('INVALID') }
      try {
        const begun = await this.call<{ epoch: number; sealed: string }>('password_vault_recovery_begin', { p_device_id: file.deviceId, p_proof: keys.proof })
        const vaultKey = await c.openVaultKey(keys.pair, begun.epoch, begun.sealed)
        try {
          // Who holds the key, as the devices signed it: from the entry the code vouched for when it was made, to now.
          // The key the cloud handed over must be the one they signed for.
          const state = await this.fetch(file, file.revision, 0)
          const head = state.initialized ? await verifyLog(this.#o.ownerId, state.log, { recoveryKey: keys.pair.publicKey }) : undefined
          if (!head || head.recovery !== keys.pair.publicKey || head.epoch !== begun.epoch || head.keyHash !== c.keyHash(this.#o.ownerId, begun.epoch, vaultKey)) throw new SyncError('INVALID')
          const { entry } = await writeEntry(this.#o.ownerId, head, { epoch: head.epoch, keyHash: head.keyHash, recovery: null,
            members: [...head.members.filter(member => member.id !== file.deviceId), { id: file.deviceId, key: file.publicKey, scope: 'full' }] },
          { id: RECOVERY_SIGNER, pair: keys.pair })
          file.pending = entry.body; await this.save()
          await this.call('password_vault_recover', { p_device_id: file.deviceId, p_proof: keys.proof, p_public_key: file.publicKey, p_epoch: begun.epoch,
            p_sealed_key: await c.sealVaultKey(file.publicKey, begun.epoch, vaultKey), p_entry: entry })
        } catch (error) { vaultKey.fill(0); throw error }
        this.#vaultKey?.key.fill(0); this.#vaultKey = { epoch: begun.epoch, key: vaultKey }
        // Pull everything and merge this device's own entries, as for any device that joins.
        Object.assign(file, { merged: false, revision: '0', versions: {}, recoveryAsked: true }); delete file.nonce; delete file.pinned; delete file.pinnedKey; await this.save()
      } finally { keys.pair.secretKey.fill(0) }
    }).then(() => this.createRecovery())
  }
  private async rotate(remove: string[], recovery: 'keep' | 'drop' | { pair: c.DeviceKeyPair; verifier: string } = 'keep') {
    const file = await this.load(), state = await this.fetch(file, '0')
    if (!state.initialized) throw new SyncError('STATE')
    const oldKey = await this.openVaultKey(state, file)
    if (!oldKey) throw new SyncError('NOT_MEMBER')
    const trusted = this.member(file), epoch = state.epoch + 1, nextKey = c.randomKey()
    try {
      const items = state.items.filter(item => !item.deleted).map(item => {
        const value = this.open(oldKey, item), version = Number(item.version) + 1
        return { itemId: item.itemId, expectedVersion: Number(item.version), ...this.seal(nextKey, epoch, item.itemId, version, value) }
      })
      // The new key goes only to devices the signed membership lists, and only while the cloud still lists them under
      // the same key: a device the cloud added on its own receives nothing.
      const keep: Member[] = trusted.members.filter(member => member.scope === 'full' && !remove.includes(member.id)
        && state.devices.some(device => device.deviceId === member.id && device.status === 'approved' && device.scope === 'full' && device.publicKey === member.key))
      const shares = await Promise.all(keep.map(async member => ({ deviceId: member.id, sealed: await c.sealVaultKey(member.key, epoch, nextKey) })))
      // The recovery code is one more holder of the key: re-sealed to the code the devices signed for, replaced by a new
      // one, or dropped.
      const recoveryKey = recovery === 'drop' ? null : recovery === 'keep' ? trusted.recovery : recovery.pair.publicKey
      const p_recovery = recovery === 'drop' || recoveryKey === null ? null : recovery === 'keep' ? { sealed: await c.sealVaultKey(recoveryKey, epoch, nextKey) }
        : { publicKey: recoveryKey, verifier: recovery.verifier, sealed: await c.sealVaultKey(recoveryKey, epoch, nextKey) }
      const { entry } = await writeEntry(this.#o.ownerId, trusted, { epoch, keyHash: c.keyHash(this.#o.ownerId, epoch, nextKey), members: keep, recovery: recoveryKey },
        this.signer(file), typeof recovery === 'object' ? recovery.pair : undefined)
      const result = await this.call<{ revision: string }>('password_vault_rotate', { p_device_id: file.deviceId, p_epoch: state.epoch, p_remove_device_ids: remove,
        p_items: items, p_shares: shares, p_recovery, p_entry: entry })
      this.#vaultKey?.key.fill(0); this.#vaultKey = { epoch, key: Buffer.from(nextKey) }
      // Re-keying changes no value: the local vault keeps these items as they are.
      for (const item of items) file.versions[item.itemId] = String(item.expectedVersion + 1)
      this.advance(file, result.revision); await this.save()
    } finally { nextKey.fill(0) }
  }

  /** Called by the vault before a local commit. A device that never joined keeps the change local; it merges on joining.
   * A joined device that cannot reach the cloud refuses the edit: offline devices read and use, they do not edit. */
  async publish(change: SyncChange): Promise<void> {
    const file = await this.load()
    if (!file.merged) return
    try {
      const state = this.#state ?? await this.fetch(file, file.revision)
      if (!state.initialized) throw new SyncError('NOT_MEMBER')
      const vaultKey = await this.openVaultKey(state, file)
      if (!vaultKey) throw new SyncError('NOT_MEMBER')
      if (change.kind === 'save') {
        try { await this.publishSave(file, state.epoch, vaultKey, change.id, change.value) }
        catch (error) { if (!(error instanceof SyncError && error.code === 'STALE' && await this.alreadyThere(file, vaultKey, change.id, change.value))) throw error }
      } else if (file.versions[change.id]) {
        const result = await this.call<{ revision: string }>('password_vault_delete', { p_device_id: file.deviceId, p_item_id: change.id, p_expected_version: Number(file.versions[change.id]) })
        file.versions[change.id] = String(Number(file.versions[change.id]) + 1); this.advance(file, result.revision); await this.save()
      }
    } catch (error) {
      // Another device changed it first (or the key moved on): the person sees a conflict, and the next refresh pulls it.
      setTimeout(() => { void this.refresh().catch(() => {}) }, 0)
      if (error instanceof SyncError && error.code === 'STALE') throw new VaultError('STALE_REFERENCE')
      throw new VaultError('UNAVAILABLE')
    }
  }
  /** A retry after the cloud write succeeded but the local commit did not: the cloud already holds exactly this value. */
  private async alreadyThere(file: DeviceFile, vaultKey: Buffer, id: string, value: SyncValue): Promise<boolean> {
    const state = await this.fetch(file, file.revision)
    const item = state.initialized ? state.items.find(entry => entry.itemId === id && !entry.deleted) : undefined
    if (!item || !sameValue(this.open(vaultKey, item), value)) return false
    file.versions[id] = item.version; await this.save()
    return true
  }
  private async publishSave(file: DeviceFile, epoch: number, vaultKey: Buffer, id: string, value: SyncValue) {
    const expected = Number(file.versions[id] ?? 0), sealed = this.seal(vaultKey, epoch, id, expected + 1, value)
    const result = await this.call<{ version: string; revision: string }>('password_vault_save', { p_device_id: file.deviceId, p_item_id: id,
      p_expected_version: expected, p_epoch: epoch, p_wrapped_key: sealed.wrappedKey, p_ciphertext: sealed.ciphertext, p_shares: [] })
    file.versions[id] = result.version; this.advance(file, result.revision); await this.save()
  }
  /** Our own write may skip the revision only when nothing else was written in between. */
  private advance(file: DeviceFile, revision: string) {
    if (BigInt(revision) === BigInt(file.revision) + 1n) file.revision = revision
    if (this.#seen !== undefined && BigInt(revision) === BigInt(this.#seen) + 1n) this.#seen = revision
  }
}
const maxRevision = (a: string, b: string) => BigInt(a) > BigInt(b) ? a : b
function toSyncError(error: unknown): SyncError {
  const value = error as { code?: string; message?: string } | undefined
  if (value?.code === '40001') return new SyncError('STALE')
  if (value?.code === '42501') return new SyncError('NOT_MEMBER')
  if (value?.code === '55000') return new SyncError('STATE')
  if (value?.code === '22023' || value?.code === '54000') return new SyncError('INVALID')
  return new SyncError('OFFLINE')
}
