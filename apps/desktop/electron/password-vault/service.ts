import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AuditInput, AuditReceipt, AuditRecord, CredentialReference, CredentialSummary, CredentialUseResult, VaultUseBinding, VaultUseCapability, LockReason, VaultDependencies, VaultState, VaultInstallationIdentity } from './contracts'
import { VaultError } from './contracts'
import { EncryptedVaultAudit } from './audit'
import { sealedJson } from './crypto'
import { auditInput, binding, credentialInputSchema, uuid, identity, httpsOrigin, maskedAccount, type VaultDocument, type VaultPayload } from './schema'
import { VaultFile } from './vault-file'
import { captureBrowserSink, performCredentialUse } from './browser-use'
import { OutcomeAuditIssuer } from './outcome-audit'
import { saveCredential, deleteCredential, type ManagementRuntime } from './management'
import { VaultFeatureOperation } from './feature-guard'
import { anySignal } from '@gugu/core/shared/anySignal'

const activeRoots = new Map<string, object>()
const safe = (error: unknown): VaultError => error instanceof VaultError ? error : new VaultError('STORAGE_FAILED')
type PendingSetup = { id: string; vaultId: string; key: Buffer; recovery: Buffer; epoch: string; feature: VaultFeatureOperation }

/** Dormant main-process service. No IPC, MCP, device action, server or diagnostic reader is registered. */
export class LocalPasswordVault {
  readonly #file: VaultFile
  readonly #audit: EncryptedVaultAudit
  readonly #outcomes: OutcomeAuditIssuer
  readonly #browser: VaultDependencies['browser']
  readonly #acquireFeatureGuard: VaultDependencies['acquireFeatureGuard']
  #epochAbort = new AbortController()
  readonly #now: () => number
  #epoch = randomUUID()
  #key?: Buffer
  #document?: VaultDocument
  #pending?: PendingSetup
  readonly #activeSecrets = new Set<{ credentialId: string; clear(): void }>()
  readonly #transientKeys = new Set<Buffer>()
  readonly #revocations = new Map<string, number>()
  #failure?: VaultState['reason']
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false
  readonly #dependencies: VaultDependencies
  constructor(dependencies: VaultDependencies) {
    if (!identity.safeParse(dependencies.accountId).success || !dependencies.installationBinding?.trim()) throw new VaultError('INVALID_INPUT')
    this.#dependencies = dependencies
    this.#browser = captureBrowserSink(dependencies.browser)
    this.#acquireFeatureGuard = dependencies.acquireFeatureGuard?.bind(dependencies)
    if (activeRoots.has(dependencies.root)) throw new VaultError('UNAVAILABLE')
    this.#file = new VaultFile(dependencies)
    this.#now = dependencies.now ?? Date.now
    this.#audit = new EncryptedVaultAudit(this.#file.disk, this.#file.owner, this.#now)
    this.#outcomes = new OutcomeAuditIssuer((event, effectPossible) => this.appendAudit(event, { effectPossible }), bound => {
      const { key, document } = this.unlocked(); this.current(bound.lockEpoch)
      const payload = this.#file.payload(document, key)
      try {
        if (bound.accountId !== this.#dependencies.accountId || bound.installationId !== document.installationId || bound.credentialVersion !== String(Number(bound.credentialVersion))) throw new VaultError('STALE_REFERENCE')
        const value = this.check({ id: bound.credentialId, version: Number(bound.credentialVersion), epoch: bound.lockEpoch }, payload)
        if (value.origin !== bound.origin) throw new VaultError('STALE_REFERENCE')
      } finally { for (const item of payload.credentials) { item.account = ''; item.password = '' } }
    })
    activeRoots.set(dependencies.root, this)
  }
  /** One fixed host-only port, never exposed through a tool, UI payload or diagnostics. */
  get outcomeAudit() { return this.#outcomes.port }
  /** Fixed host reader, never a tool/person export. Safe to call from readiness readers: no writer queue re-entry. */
  async prepareInstallationIdentity(): Promise<VaultInstallationIdentity> {
    if (this.#disposed || this.#failure) throw new VaultError('UNAVAILABLE')
    const epoch = this.#epoch, signal = this.#epochAbort.signal
    await this.gates()
    const value = Object.freeze(await this.#file.prepareInstallationIdentity())
    const assertCurrent = () => {
      // No feature.assertCurrent here: this fact is itself checked by that guard.
      if (this.#disposed || this.#failure || this.#epoch !== epoch || signal.aborted) throw new VaultError('UNAVAILABLE')
      this.#file.assertInstallationIdentity(value.installationId)
    }
    assertCurrent()
    return Object.freeze({ value, generation: epoch, signal, assertCurrent })
  }
  /** Trusted local settings only. An installation manifest alone does not initialize this account's vault. */
  isInitialized(context: object): Promise<boolean> {
    this.person(context)
    return this.run(async () => {
      const epoch = this.#epoch
      const current = () => { this.person(context); this.current(epoch); if (this.#failure) throw new VaultError(this.#failure) }
      current(); await this.gates()
      // Validate an absent installation's empty root too; unrelated/corrupt data is never a fresh vault.
      await this.#file.prepareInstallationIdentity(); current()
      let initialized = true
      try { await this.#file.load() }
      catch (error) { if (!(error instanceof VaultError) || error.code !== 'NOT_INITIALIZED') throw error; initialized = false }
      current()
      return initialized
    })
  }
  state(): VaultState { return { status: this.#failure ? 'unavailable' : this.#key ? 'unlocked' : 'locked', epoch: this.#epoch, ...(this.#failure ? { reason: this.#failure } : {}) } }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => { if (this.#disposed) throw new VaultError('UNAVAILABLE'); try { return await operation() } catch (error) { throw safe(error) } })
    this.#queue = result.catch(() => undefined)
    return result
  }
  toJSON() { return { type: 'LocalPasswordVault', status: this.state().status } }
  private person(context: object): void {
    if (this.#disposed) throw new VaultError('UNAVAILABLE')
    try { this.#dependencies.assertLocalPerson(context) } catch { throw new VaultError('UNAVAILABLE') }
  }
  private current(epoch: string): void {
    if (this.#epoch !== epoch || this.#disposed) throw new VaultError('CANCELLED')
    this.#file.disk.feature?.assertCurrent()
  }
  private unlocked(): { key: Buffer; document: VaultDocument; epoch: string } {
    if (this.#failure) throw new VaultError(this.#failure)
    if (!this.#key || !this.#document) throw new VaultError('LOCKED')
    return { key: this.#key, document: this.#document, epoch: this.#epoch }
  }
  private async gates(): Promise<void> {
    try { await this.#dependencies.assertPrivateStorageReady(); this.#file.disk.feature?.assertCurrent() }
    catch { throw new VaultError('UNAVAILABLE') }
  }
  private feature(operation: 'save' | 'use', signal?: AbortSignal): Promise<VaultFeatureOperation> {
    return VaultFeatureOperation.acquire(this.#acquireFeatureGuard, operation, signal ? anySignal([signal, this.#epochAbort.signal]) : this.#epochAbort.signal)
  }
  private wipe(): void {
    const pending = this.#pending; this.#pending = undefined
    this.#epochAbort.abort(); this.#epochAbort = new AbortController()
    this.#outcomes.clear()
    for (const secret of this.#activeSecrets) secret.clear()
    this.#activeSecrets.clear()
    for (const key of this.#transientKeys) key.fill(0)
    this.#transientKeys.clear()
    this.#key?.fill(0); this.#key = undefined; this.#document = undefined
    pending?.feature.release(); pending?.key.fill(0); pending?.recovery.fill(0)
  }
  private async record(input: AuditInput): Promise<string> {
    const { key, document, epoch } = this.unlocked()
    try {
      const existing = await this.#audit.existing(document, key, this.#dependencies.accountId, input)
      this.current(epoch)
      if (existing) return existing
      const entry = this.#audit.prepare(document, key, this.#dependencies.accountId, input)
      await this.#audit.persist(entry)
      this.current(epoch)
      return entry.id
    } catch (error) {
      if (this.#epoch !== epoch) throw new VaultError('CANCELLED')
      if (this.#file.disk.feature?.signal.aborted) throw new VaultError('UNAVAILABLE')
      await this.fail(); throw new VaultError('AUDIT_FAILED')
    }
  }
  beginSetup(context: object): Promise<{ setupId: string; recoveryMaterial: string }> {
    this.person(context)
    return this.run(async () => {
      const epoch = this.#epoch, feature = await this.feature('save')
      try {
        return await this.#file.disk.withFeature(feature, async () => {
          await feature.wait(() => this.gates()); await feature.wait(() => this.#file.assertEmpty())
          await feature.wait(() => this.#dependencies.keys.verifyPerson()); this.current(epoch)
          const previous = this.#pending; this.#pending = undefined
          previous?.feature.release(); previous?.key.fill(0); previous?.recovery.fill(0)
          const pending: PendingSetup = { id: randomUUID(), vaultId: randomUUID(), key: randomBytes(32), recovery: randomBytes(32), epoch, feature }
          this.#pending = pending
          feature.onInvalidate(() => { if (this.#pending === pending) { pending.key.fill(0); pending.recovery.fill(0); this.#pending = undefined } })
          feature.assertCurrent()
          return { setupId: pending.id, recoveryMaterial: `gugu-vault-v1.${pending.vaultId}.${pending.recovery.toString('base64url')}` }
        })
      } catch (error) { feature.release(); throw error }
    })
  }
  confirmRecovery(context: object, setupId: string, material: string): Promise<void> {
    this.person(context)
    return this.run(async () => {
      const pending = this.#pending
      if (!pending || pending.id !== setupId) throw new VaultError('RECOVERY_INVALID')
      try { this.current(pending.epoch); pending.feature.assertCurrent() }
      catch (error) { pending.feature.release(); throw error }
      const expected = Buffer.from(`gugu-vault-v1.${pending.vaultId}.${pending.recovery.toString('base64url')}`), actual = Buffer.from(material)
      try { if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new VaultError('RECOVERY_INVALID') }
      finally { expected.fill(0); actual.fill(0) }
      try {
        await this.#file.disk.withFeature(pending.feature, async () => {
          await pending.feature.wait(() => this.gates())
          const document = await pending.feature.wait(() => this.#file.make(pending.key, pending.recovery, pending.vaultId, { credentials: [], operations: [] }))
          this.current(pending.epoch)
          await pending.feature.wait(() => this.#file.create(document)); this.current(pending.epoch)
          this.#key = pending.key; this.#document = document; this.#pending = undefined; pending.recovery.fill(0); this.#failure = undefined
          await this.record({ id: randomUUID(), action: 'setup', source: 'local-person', outcome: 'completed' }); pending.feature.assertCurrent()
        })
      } catch (error) { this.wipe(); this.#failure = safe(error).code; throw safe(error) }
      finally { pending.feature.release() }
    })
  }
  unlock(context: object): Promise<void> {
    this.person(context)
    return this.run(async () => {
      if (this.#key) throw new VaultError('INVALID_INPUT')
      const epoch = this.#epoch
      let key: Buffer | undefined
      try {
        await this.gates(); const document = await this.#file.load()
        await this.#dependencies.keys.verifyPerson(); this.current(epoch)
        key = await this.#dependencies.keys.unwrap(document.localKey, binding(document, 'local')); this.#transientKeys.add(key); this.current(epoch)
        this.#file.payload(document, key)
        this.#key = key; this.#document = document; this.#failure = undefined
        await this.record({ id: randomUUID(), action: 'unlock', source: 'local-person', outcome: 'completed' })
      } catch (error) { key?.fill(0); this.wipe(); throw safe(error) }
      finally { if (key) this.#transientKeys.delete(key) }
    })
  }
  recover(context: object, material: string): Promise<void> {
    this.person(context)
    return this.run(async () => {
      if (this.#key) throw new VaultError('INVALID_INPUT')
      const epoch = this.#epoch
      let key: Buffer | undefined
      try {
        await this.gates(); const document = await this.#file.load()
        await this.#dependencies.keys.verifyPerson(); this.current(epoch)
        key = this.#file.recover(document, material); this.#transientKeys.add(key)
        this.#file.payload(document, key)
        const localKey = await this.#dependencies.keys.wrap(key, binding(document, 'local')); this.current(epoch)
        await this.#file.persist({ ...document, localKey }); this.current(epoch)
        this.#key = key; this.#document = { ...document, localKey }; this.#failure = undefined
        await this.record({ id: randomUUID(), action: 'recovery', source: 'local-person', outcome: 'completed' })
      } catch (error) { key?.fill(0); this.wipe(); throw safe(error) }
      finally { if (key) this.#transientKeys.delete(key) }
    })
  }
  /** Revocation and zeroing happen synchronously, before any I/O or queued cleanup. */
  lock(reason: LockReason = 'explicit'): Promise<void> {
    let entry: ReturnType<EncryptedVaultAudit['prepare']> | undefined
    try { if (this.#key && this.#document) entry = this.#audit.prepare(this.#document, this.#key, this.#dependencies.accountId, { id: randomUUID(), action: 'lock', source: 'lifecycle', outcome: 'completed' }) }
    catch { this.#failure = 'AUDIT_FAILED' }
    this.#epoch = randomUUID(); this.wipe()
    let cleanup: Promise<void>
    try { cleanup = this.#dependencies.invalidate({ epoch: this.#epoch, reason }) } catch { cleanup = Promise.reject(new VaultError('UNAVAILABLE')) }
    // Observe rejection immediately even if another operation still owns the queue.
    const settled = cleanup.then(() => true, () => false)
    return this.run(async () => {
      try { if (entry) await this.#audit.persist(entry); if (!await settled) throw new VaultError('UNAVAILABLE') }
      catch { this.#failure = 'AUDIT_FAILED'; throw new VaultError('AUDIT_FAILED') }
    })
  }
  list(context: object): Promise<CredentialSummary[]> {
    this.person(context)
    return this.run(async () => {
      await this.gates(); const { key, document, epoch } = this.unlocked()
      return this.#file.payload(document, key).credentials.map(value => ({ reference: { id: value.id, version: value.version, epoch }, origin: value.origin, maskedAccount: maskedAccount(value.account) }))
    })
  }
  private check(reference: CredentialReference, payload: VaultPayload, managing = false) {
    const value = payload.credentials.find(item => item.id === reference.id)
    if ((!managing && this.#revocations.has(reference.id)) || reference.epoch !== this.#epoch || !value || value.version !== reference.version) throw new VaultError('STALE_REFERENCE')
    return value
  }
  checkReference(actor: object, reference: CredentialReference): Promise<{ status: 'valid'; installationId: string } | { status: 'locked' | 'invalidated' | 'unavailable' }> {
    try { if (!this.#dependencies.assertOwnedLocalAgent) throw new Error(); this.#dependencies.assertOwnedLocalAgent(actor) }
    catch { return Promise.resolve({ status: 'unavailable' }) }
    return this.run(async () => {
      try { await this.gates(); const { key, document } = this.unlocked(); this.check(reference, this.#file.payload(document, key)); return { status: 'valid', installationId: document.installationId } }
      catch (error) { return { status: safe(error).code === 'LOCKED' ? 'locked' : safe(error).code === 'STALE_REFERENCE' ? 'invalidated' : 'unavailable' } }
    })
  }
  private revoke(reference: CredentialReference | undefined, reason: 'edit' | 'delete') {
    if (!reference) return { cleanup: Promise.resolve(true), release() {} }
    const id = reference.id
    this.#revocations.set(id, (this.#revocations.get(id) ?? 0) + 1)
    for (const secret of this.#activeSecrets) if (secret.credentialId === id) secret.clear()
    let cleanup: Promise<boolean>
    try { cleanup = this.#dependencies.invalidate({ epoch: this.#epoch, reason, credentialId: id }).then(() => true, () => false) }
    catch { cleanup = Promise.resolve(false) }
    return { cleanup, release: () => { const count = this.#revocations.get(id)! - 1; if (count) this.#revocations.set(id, count); else this.#revocations.delete(id) } }
  }
  private management(cleanup: Promise<boolean>, feature?: VaultFeatureOperation): ManagementRuntime & { release(): void } {
    const { key, document, epoch } = this.unlocked(), payload = this.#file.payload(document, key)
    const sensitive = { credentialId: '', clear() { for (const item of payload.credentials) { item.account = ''; item.password = '' } } }
    this.#activeSecrets.add(sensitive)
    const detach = feature?.onInvalidate(() => sensitive.clear()), current = () => { this.current(epoch); feature?.assertCurrent() }
    return { key, epoch, payload, cleanup, release: () => { detach?.(); sensitive.clear(); this.#activeSecrets.delete(sensitive) }, check: reference => this.check(reference, payload, true), current, record: event => this.record(event),
      persist: async value => { current(); const next = { ...document, payload: sealedJson(key, value, binding(document, 'data')) }; await this.#file.persist(next); current(); this.#document = next } }
  }
  save(context: object, operationId: string, input: { origin: string; account: string; password: string }, previous?: CredentialReference): Promise<CredentialSummary> {
    this.person(context)
    if (!uuid.safeParse(operationId).success) return Promise.reject(new VaultError('INVALID_INPUT'))
    const validated = credentialInputSchema.safeParse(input)
    if (!validated.success) return Promise.reject(new VaultError('INVALID_INPUT'))
    const normalized = { ...validated.data, origin: httpsOrigin(input.origin) }, revocation = this.revoke(previous, 'edit')
    const sensitive = { credentialId: '', clear() { normalized.account = ''; normalized.password = '' } }; this.#activeSecrets.add(sensitive)
    return this.run(async () => {
      let runtime: ReturnType<LocalPasswordVault['management']> | undefined, feature: VaultFeatureOperation | undefined
      try {
        const held = feature = await this.feature('save'); held.onInvalidate(() => sensitive.clear())
        return await this.#file.disk.withFeature(held, async () => {
          await held.wait(() => this.gates()); runtime = this.management(revocation.cleanup, held)
          const result = await saveCredential(runtime, operationId, normalized, previous); held.assertCurrent(); return result
        })
      } catch (error) {
        if (safe(error).code === 'UNAVAILABLE' && feature?.writeStarted) { await this.fail('STORAGE_FAILED'); throw new VaultError('STORAGE_FAILED') }
        if (['STORAGE_FAILED', 'DATA_DAMAGED', 'AUDIT_FAILED'].includes(safe(error).code)) await this.fail()
        throw safe(error)
      } finally { runtime?.release(); feature?.release() }
    }).finally(() => { revocation.release(); sensitive.clear(); this.#activeSecrets.delete(sensitive) })
  }
  delete(context: object, operationId: string, reference: CredentialReference): Promise<void> {
    this.person(context)
    if (!uuid.safeParse(operationId).success) return Promise.reject(new VaultError('INVALID_INPUT'))
    const revocation = this.revoke(reference, 'delete')
    return this.run(async () => {
      let runtime: ReturnType<LocalPasswordVault['management']> | undefined
      try { await this.gates(); runtime = this.management(revocation.cleanup); await deleteCredential(runtime, operationId, reference) }
      catch (error) { if (['STORAGE_FAILED', 'DATA_DAMAGED', 'AUDIT_FAILED'].includes(safe(error).code)) await this.fail(); throw safe(error) }
      finally { runtime?.release() }
    }).finally(revocation.release)
  }
  /** For the trusted approval/browser coordinator only. This method never accepts passwords or raw errors. */
  appendAudit(input: AuditInput, { effectPossible }: { effectPossible: boolean }): Promise<AuditReceipt> {
    let validated: AuditInput
    try { validated = auditInput(input) } catch { return Promise.resolve({ status: effectPossible ? 'uncertain' : 'unavailable', code: 'AUDIT_FAILED', retry: false, retainIsolatedLogin: true }) }
    return this.run(async () => {
      try { await this.gates(); return { status: 'recorded', recordId: await this.record(validated) } }
      catch { await this.fail(); return { status: effectPossible ? 'uncertain' : 'unavailable', code: 'AUDIT_FAILED', retry: false, retainIsolatedLogin: true } }
    })
  }
  useCredential(capability: VaultUseCapability, useBinding: VaultUseBinding): Promise<CredentialUseResult> {
    const sink = this.#browser
    if (!sink) return Promise.resolve({ status: 'unavailable', retry: false, retainIsolatedLogin: true })
    // Copy the binding; mutating a caller-owned object while waiting must not change the authorization.
    const bound = Object.freeze({ ...useBinding })
    let feature: VaultFeatureOperation | undefined
    return performCredentialUse(sink, capability, bound, control => this.run(async () => {
      // Proof-only cleanup stops filling; it must not revoke the continuing readiness/audit qualification.
      const revoked = control.revokedSignal
      if (!(revoked instanceof AbortSignal) || revoked.aborted) throw new VaultError('UNAVAILABLE')
      const held = feature = await this.feature('use', revoked)
      return this.#file.disk.withFeature(held, async () => {
        await held.wait(() => this.gates())
        const { key, document, epoch } = this.unlocked(), payload = this.#file.payload(document, key)
        try {
          const value = this.check({ id: bound.credentialId, version: Number(bound.credentialVersion), epoch: bound.lockEpoch }, payload)
          if (bound.accountId !== this.#dependencies.accountId || bound.installationId !== document.installationId || bound.credentialVersion !== String(value.version) || bound.origin !== value.origin) throw new VaultError('STALE_REFERENCE')
          control.assertCurrent(); held.assertCurrent(); this.current(epoch)
          const abort = new AbortController(), account = Buffer.from(value.account), password = Buffer.from(value.password), credentialId = value.id
          const secret = { credentialId, clear() { abort.abort(); account.fill(0); password.fill(0) } }
          this.#activeSecrets.add(secret)
          const detach = held.onInvalidate(() => secret.clear())
          return { account, password, signal: abort.signal,
            assertCurrent: () => { held.assertCurrent(); this.current(epoch); if (!this.#key || this.#failure || this.#revocations.has(credentialId)) throw new VaultError('LOCKED') },
            release: () => { detach(); secret.clear(); this.#activeSecrets.delete(secret) } }
        } finally { for (const item of payload.credentials) { item.account = ''; item.password = '' } }
      })
    }), (entry, effectPossible) => feature ? this.#file.disk.withFeature(feature, () => this.appendAudit(entry, { effectPossible })) : Promise.resolve({ status: 'unavailable', code: 'AUDIT_FAILED', retry: false, retainIsolatedLogin: true }), this.#outcomes).finally(() => feature?.release())
  }
  readAudit(context: object): Promise<AuditRecord[]> {
    this.person(context)
    return this.run(async () => { await this.gates(); const { document, key, epoch } = this.unlocked(); const records = await this.#audit.read(document, key, this.#dependencies.accountId); this.current(epoch); return records })
  }
  clearAudit(context: object): Promise<void> {
    this.person(context)
    return this.run(async () => {
      const epoch = this.#epoch
      let temporary: Buffer | undefined
      try {
        await this.gates()
        if (!this.#key) {
          const document = await this.#file.load()
          await this.#dependencies.keys.verifyPerson(); this.current(epoch)
          temporary = await this.#dependencies.keys.unwrap(document.localKey, binding(document, 'local')); this.#transientKeys.add(temporary); this.current(epoch)
          this.#file.payload(document, temporary)
          await this.#audit.clear(); this.#outcomes.clear(); this.current(epoch)
          await this.#audit.persist(this.#audit.prepare(document, temporary, this.#dependencies.accountId, { id: randomUUID(), action: 'clear', source: 'local-person', outcome: 'completed' }))
          this.current(epoch); this.#failure = undefined
        } else {
          this.unlocked(); await this.#audit.clear(); this.#outcomes.clear(); this.current(epoch)
          await this.record({ id: randomUUID(), action: 'clear', source: 'local-person', outcome: 'completed' })
        }
      } catch { await this.fail(); throw new VaultError('AUDIT_FAILED') }
      finally { temporary?.fill(0); if (temporary) this.#transientKeys.delete(temporary) }
    })
  }
  private async fail(reason: VaultState['reason'] = 'AUDIT_FAILED'): Promise<void> {
    this.#epoch = randomUUID(); this.wipe(); this.#failure = reason
    try { await this.#dependencies.invalidate({ epoch: this.#epoch, reason: 'failure' }) } catch { /* State stays unavailable; browser owner retains its cleanup obligation. */ }
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return
    try { await this.lock('app-exit'); await this.#queue }
    finally { this.#disposed = true; this.wipe(); if (activeRoots.get(this.#dependencies.root) === this) activeRoots.delete(this.#dependencies.root) }
  }
}
