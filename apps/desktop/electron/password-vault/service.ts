import { randomBytes, randomUUID } from 'node:crypto'
import type { AuditInput, AuditReceipt, AuditRecord, CredentialGrant, CredentialInput, CredentialReference, CredentialSecrets, CredentialSummary, CredentialUseResult, VaultFillPlan, VaultUseBinding, VaultUseCapability, LockReason, VaultDependencies, VaultState, VaultInstallationIdentity } from './contracts'
import { VaultError } from './contracts'
import { EncryptedVaultAudit } from './audit'
import { sealedJson } from './crypto'
import { auditInput, binding, credentialInputSchema, grantSchema, payloadSchema, uuid, identity, httpsOrigin, type VaultDocument, type VaultPayload } from './schema'
import { VaultFile } from './vault-file'
import { captureBrowserSink, performCredentialUse } from './browser-use'
import { OutcomeAuditIssuer } from './outcome-audit'
import { totpCode } from './totp'
import { saveCredential, deleteCredential, updateGrants, summary, type ManagementRuntime, type SyncValue } from './management'
import { VaultFeatureOperation } from './feature-guard'
import { anySignal } from '@gugu/core/shared/anySignal'

const activeRoots = new Map<string, object>()
const safe = (error: unknown): VaultError => error instanceof VaultError ? error : new VaultError('STORAGE_FAILED')

/** Main-process service. The vault opens on first use with the Keychain-wrapped key; there is no person setup/unlock step.
 * Lock only drops in-memory keys and secrets; the next operation reopens. Local verification is required only to reveal plaintext. */
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
  readonly #activeSecrets = new Set<{ credentialId: string; clear(): void }>()
  readonly #transientKeys = new Set<Buffer>()
  readonly #revocations = new Map<string, number>()
  #failure?: VaultState['reason']
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false
  /** Uses the person approved on a website that is not the credential's (useId). Forgotten on lock. */
  readonly #elsewhere = new Set<string>()
  /** Uses with no saved credential behind them (every value typed for that use): nothing to look up afterwards. */
  readonly #transient = new Set<string>()
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
        if (this.#transient.has(bound.useId)) return
        const value = this.check({ id: bound.credentialId, version: Number(bound.credentialVersion), epoch: bound.lockEpoch }, payload)
        if (value.origin !== bound.origin && !value.sites.includes(bound.origin) && !this.#elsewhere.has(bound.useId)) throw new VaultError('STALE_REFERENCE')
      } finally { for (const item of payload.credentials) { item.account = ''; item.password = ''; for (const field of item.fields) field.value = '' } }
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
    this.#epochAbort.abort(); this.#epochAbort = new AbortController()
    this.#outcomes.clear(); this.#elsewhere.clear(); this.#transient.clear()
    for (const secret of this.#activeSecrets) secret.clear()
    this.#activeSecrets.clear()
    for (const key of this.#transientKeys) key.fill(0)
    this.#transientKeys.clear()
    this.#key?.fill(0); this.#key = undefined; this.#document = undefined
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
  /** Opens (or on first use creates) this account's vault. Runs inside the writer queue; no person step. */
  private async open(held?: VaultFeatureOperation, person = false): Promise<void> {
    // A storage/audit failure latches for Agent paths; a local person operation may retry a clean reopen.
    if (this.#failure && !person) throw new VaultError(this.#failure)
    if (this.#key && this.#document && !this.#failure) return
    const epoch = this.#epoch
    let document: VaultDocument | undefined
    try { document = await this.#file.load() }
    catch (error) { if (!(error instanceof VaultError) || error.code !== 'NOT_INITIALIZED') throw error }
    if (document) {
      let key: Buffer | undefined
      try {
        key = await this.#dependencies.keys.unwrap(document.localKey, binding(document, 'local')); this.#transientKeys.add(key); this.current(epoch)
        this.#file.payload(document, key)
        this.#key = key; this.#document = document; this.#failure = undefined
      } catch (error) { key?.fill(0); throw safe(error) }
      finally { if (key) this.#transientKeys.delete(key) }
      return
    }
    const feature = held ?? await this.feature('save')
    const key = randomBytes(32)
    try {
      await this.#file.disk.withFeature(feature, async () => {
        await feature.wait(() => this.#file.assertEmpty())
        const created = await feature.wait(() => this.#file.make(key, randomUUID(), { credentials: [], operations: [] }))
        this.current(epoch)
        await feature.wait(() => this.#file.create(created)); this.current(epoch)
        this.#key = key; this.#document = created
        await this.record({ id: randomUUID(), action: 'setup', source: 'lifecycle', outcome: 'completed' })
      })
    } catch (error) { if (this.#key !== key) key.fill(0); throw safe(error) }
    finally { if (!held) feature.release() }
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
      await this.gates(); await this.open(undefined, true); const { key, document, epoch } = this.unlocked()
      const payload = this.#file.payload(document, key)
      try { return payload.credentials.map(value => summary(value, epoch)) }
      finally { for (const item of payload.credentials) { item.account = ''; item.password = ''; for (const field of item.fields) field.value = '' } }
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
      try { await this.gates(); await this.open(); const { key, document } = this.unlocked(); this.check(reference, this.#file.payload(document, key)); return { status: 'valid', installationId: document.installationId } }
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
    const sensitive = { credentialId: '', clear() { for (const item of payload.credentials) { item.account = ''; item.password = ''; for (const field of item.fields) field.value = '' } } }
    this.#activeSecrets.add(sensitive)
    const detach = feature?.onInvalidate(() => sensitive.clear()), current = () => { this.current(epoch); feature?.assertCurrent() }
    const publish = this.#dependencies.sync ? (change: Parameters<ManagementRuntime['publish']>[0]) => this.#dependencies.sync!.publish(change) : () => Promise.resolve()
    return { key, epoch, payload, cleanup, publish, release: () => { detach?.(); sensitive.clear(); this.#activeSecrets.delete(sensitive) }, check: reference => this.check(reference, payload, true), current, record: event => this.record(event),
      persist: async value => { current(); const next = { ...document, payload: sealedJson(key, value, binding(document, 'data')) }; await this.#file.persist(next); current(); this.#document = next } }
  }
  save(context: object, operationId: string, input: CredentialInput, previous?: CredentialReference, creator?: CredentialGrant): Promise<CredentialSummary> {
    this.person(context)
    if (!uuid.safeParse(operationId).success) return Promise.reject(new VaultError('INVALID_INPUT'))
    const validated = credentialInputSchema.safeParse(input)
    if (!validated.success || creator && !grantSchema.safeParse(creator).success) return Promise.reject(new VaultError('INVALID_INPUT'))
    if (!previous && !validated.data.account && !validated.data.password && !validated.data.fields.length) return Promise.reject(new VaultError('INVALID_INPUT'))
    let origin: string
    try { origin = httpsOrigin(input.origin) } catch (error) { return Promise.reject(safe(error)) }
    const normalized = { ...validated.data, origin }, revocation = this.revoke(previous, 'edit')
    const sensitive = { credentialId: '', clear() { normalized.account = ''; normalized.password = ''; for (const field of normalized.fields) field.value = '' } }; this.#activeSecrets.add(sensitive)
    return this.run(async () => {
      let runtime: ReturnType<LocalPasswordVault['management']> | undefined, feature: VaultFeatureOperation | undefined
      try {
        const held = feature = await this.feature('save'); held.onInvalidate(() => sensitive.clear())
        return await this.#file.disk.withFeature(held, async () => {
          await held.wait(() => this.gates()); await held.wait(() => this.open(held, true)); runtime = this.management(revocation.cleanup, held)
          const result = await saveCredential(runtime, operationId, normalized, previous, creator); held.assertCurrent(); return result
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
      try { await this.gates(); await this.open(undefined, true); runtime = this.management(revocation.cleanup); await deleteCredential(runtime, operationId, reference) }
      catch (error) { if (['STORAGE_FAILED', 'DATA_DAMAGED', 'AUDIT_FAILED'].includes(safe(error).code)) await this.fail(); throw safe(error) }
      finally { runtime?.release() }
    }).finally(revocation.release)
  }
  /** Person-only: replace who may use/maintain one credential. */
  setGrants(context: object, reference: CredentialReference, grants: CredentialGrant[]): Promise<CredentialSummary> {
    this.person(context)
    if (!Array.isArray(grants) || grants.some(grant => !grantSchema.safeParse(grant).success)) return Promise.reject(new VaultError('INVALID_INPUT'))
    const copy = grants.map(grant => ({ subject: grant.subject, level: grant.level }))
    return this.run(async () => {
      let runtime: ReturnType<LocalPasswordVault['management']> | undefined
      try { await this.gates(); await this.open(undefined, true); runtime = this.management(Promise.resolve(true)); return await updateGrants(runtime, reference, copy) }
      catch (error) { if (['STORAGE_FAILED', 'DATA_DAMAGED', 'AUDIT_FAILED'].includes(safe(error).code)) await this.fail(); throw safe(error) }
      finally { runtime?.release() }
    })
  }
  /** Sync engine only (same trusted person context): every credential in plaintext, for the first upload and merge. */
  syncExport(context: object): Promise<(SyncValue & { id: string })[]> {
    this.person(context)
    return this.run(async () => {
      await this.gates(); await this.open(undefined, true); const { key, document } = this.unlocked()
      return this.#file.payload(document, key).credentials.map(({ version: _version, ...value }) => value)
    })
  }
  /** Sync engine only: apply changes pulled from the cloud. Each changed credential is revoked like a local edit, so
   * in-flight uses of it stop; its local version moves on, so stale references fail. */
  syncApply(context: object, changes: { id: string; value?: SyncValue }[]): Promise<void> {
    this.person(context)
    if (!changes.length) return Promise.resolve()
    return this.run(async () => {
      let runtime: ReturnType<LocalPasswordVault['management']> | undefined
      const revocations: ReturnType<LocalPasswordVault['revoke']>[] = []
      try {
        await this.gates(); await this.open(undefined, true)
        const { key, document, epoch } = this.unlocked(), before = this.#file.payload(document, key)
        for (const change of changes) {
          const old = before.credentials.find(item => item.id === change.id)
          if (old) revocations.push(this.revoke({ id: old.id, version: old.version, epoch }, change.value ? 'edit' : 'delete'))
        }
        for (const item of before.credentials) { item.account = ''; item.password = ''; for (const field of item.fields) field.value = '' }
        await Promise.all(revocations.map(revocation => revocation.cleanup))
        runtime = this.management(Promise.resolve(true))
        const { payload } = runtime, events: AuditInput[] = []
        for (const change of changes) {
          const old = payload.credentials.find(item => item.id === change.id)
          if (!change.value && !old) continue
          const parsed = change.value ? payloadSchema.shape.credentials.element.safeParse({ ...change.value, id: change.id, version: (old?.version ?? 0) + 1 }) : undefined
          if (parsed && !parsed.success) throw new VaultError('DATA_DAMAGED')
          payload.credentials = [...payload.credentials.filter(item => item.id !== change.id), ...(parsed ? [parsed.data] : [])]
          events.push({ id: randomUUID(), action: parsed ? old ? 'edit' : 'add' : 'delete', source: 'lifecycle', outcome: 'completed',
            credential: { id: change.id, version: parsed?.data.version ?? old!.version }, origin: parsed?.data.origin ?? old!.origin })
        }
        await runtime.persist(payload)
        for (const event of events) await this.record(event)
      } catch (error) { if (['STORAGE_FAILED', 'DATA_DAMAGED', 'AUDIT_FAILED'].includes(safe(error).code)) await this.fail(); throw safe(error) }
      finally { runtime?.release(); for (const revocation of revocations) revocation.release() }
    })
  }
  /** Person-only plaintext for the settings eye button, after local system verification (Touch ID or login password). */
  reveal(context: object, reference: CredentialReference): Promise<CredentialSecrets> {
    this.person(context)
    return this.run(async () => {
      await this.gates(); await this.open(undefined, true)
      const epoch = this.#epoch
      await this.#dependencies.keys.verifyPerson(); this.current(epoch)
      const { key, document } = this.unlocked(), payload = this.#file.payload(document, key)
      try {
        const value = this.check(reference, payload, true)
        await this.record({ id: randomUUID(), action: 'reveal', source: 'local-person', outcome: 'completed', credential: { id: value.id, version: value.version }, origin: value.origin })
        return { account: value.account, password: value.password, fields: value.fields.map(field => ({ ...field })) }
      } finally { for (const item of payload.credentials) { item.account = ''; item.password = ''; for (const field of item.fields) field.value = '' } }
    })
  }
  /** 「本机送」(server-delivery.ts), for the trusted coordinator only, after a grant or the person's approval: this
   * credential's account and password, sealed by `seal` to the requesting server; the plaintext never leaves here. */
  releaseToServer(reference: CredentialReference, seal: (plain: Buffer) => Promise<string>,
    audit: { agentId: string; sessionId: string; requestId: string }): Promise<string> {
    let feature: VaultFeatureOperation | undefined
    return this.run(async () => {
      const held = feature = await this.feature('use')
      return this.#file.disk.withFeature(held, async () => {
        await held.wait(() => this.gates()); await held.wait(() => this.open(held))
        const { key, document, epoch } = this.unlocked(), payload = this.#file.payload(document, key)
        let plain: Buffer | undefined
        try {
          const value = this.check(reference, payload)
          held.assertCurrent(); this.current(epoch)
          plain = Buffer.from(JSON.stringify({ account: value.account, password: value.password }))
          const sealed = await seal(plain)
          await this.record({ id: randomUUID(), action: 'use', source: 'policy', outcome: 'completed', agentId: audit.agentId, sessionId: audit.sessionId,
            requestId: audit.requestId, credential: { id: value.id, version: value.version }, origin: value.origin })
          return sealed
        } finally {
          plain?.fill(0)
          for (const item of payload.credentials) { item.account = ''; item.password = ''; for (const field of item.fields) field.value = '' }
        }
      })
    }).finally(() => feature?.release())
  }
  /** For the trusted approval/browser coordinator only. This method never accepts passwords or raw errors. */
  appendAudit(input: AuditInput, { effectPossible }: { effectPossible: boolean }): Promise<AuditReceipt> {
    let validated: AuditInput
    try { validated = auditInput(input) } catch { return Promise.resolve({ status: effectPossible ? 'uncertain' : 'unavailable', code: 'AUDIT_FAILED', retry: false, retainIsolatedLogin: true }) }
    return this.run(async () => {
      try { await this.gates(); await this.open(); return { status: 'recorded', recordId: await this.record(validated) } }
      catch { await this.fail(); return { status: effectPossible ? 'uncertain' : 'unavailable', code: 'AUDIT_FAILED', retry: false, retainIsolatedLogin: true } }
    })
  }
  /** `plan`: which values, in the order of the page's targets; built by the trusted host from the approved request. */
  useCredential(capability: VaultUseCapability, useBinding: VaultUseBinding, plan: VaultFillPlan): Promise<CredentialUseResult> {
    const sink = this.#browser
    if (!sink || !plan || !Array.isArray(plan.values) || !plan.values.length || plan.values.length > 16) return Promise.resolve({ status: 'unavailable', retry: false, retainIsolatedLogin: true })
    const wanted = Object.freeze(plan.values.map(entry => Object.freeze({ ...entry }))), elsewhere = plan.elsewhere === true
    const typed = Object.freeze(plan.values.map((_entry, index) => { const text = plan.typed?.[index]; return typeof text === 'string' && text ? text : undefined }))
    const transient = plan.transient === true
    // Nothing saved: every value must have been typed for this use, and none may name a stored one.
    if (transient && wanted.some((entry, index) => entry.kind !== 'typed' || !typed[index])) return Promise.resolve({ status: 'unavailable', retry: false, retainIsolatedLogin: true })
    if (transient) {
      this.#transient.add(useBinding.useId)
      if (this.#transient.size > 256) this.#transient.delete(this.#transient.values().next().value!)
    }
    if (elsewhere) {
      this.#elsewhere.add(useBinding.useId)
      if (this.#elsewhere.size > 256) this.#elsewhere.delete(this.#elsewhere.values().next().value!)
    }
    // Copy the binding; mutating a caller-owned object while waiting must not change the authorization.
    const bound = Object.freeze({ ...useBinding })
    let feature: VaultFeatureOperation | undefined
    return performCredentialUse(sink, capability, bound, control => this.run(async () => {
      // Proof-only cleanup stops filling; it must not revoke the continuing readiness/audit qualification.
      const revoked = control.revokedSignal
      if (!(revoked instanceof AbortSignal) || revoked.aborted) throw new VaultError('UNAVAILABLE')
      const held = feature = await this.feature('use', revoked)
      return this.#file.disk.withFeature(held, async () => {
        await held.wait(() => this.gates()); await held.wait(() => this.open(held))
        const { key, document, epoch } = this.unlocked(), payload = this.#file.payload(document, key)
        try {
          if (bound.accountId !== this.#dependencies.accountId || bound.installationId !== document.installationId) throw new VaultError('STALE_REFERENCE')
          const value = transient ? undefined : this.check({ id: bound.credentialId, version: Number(bound.credentialVersion), epoch: bound.lockEpoch }, payload)
          if (value && bound.credentialVersion !== String(value.version)) throw new VaultError('STALE_REFERENCE')
          // Its own website or one of its sites; another one only with the person's approval of this very use.
          if (value && bound.origin !== value.origin && !value.sites.includes(bound.origin) && !elsewhere) throw new VaultError('STALE_REFERENCE')
          if (!value && bound.lockEpoch !== epoch) throw new VaultError('STALE_REFERENCE')
          const text = wanted.map((entry, index) => {
            if (typed[index]) return typed[index]!
            if (!value || entry.kind === 'typed') throw new VaultError('UNAVAILABLE')
            if (entry.kind === 'account') return value.account
            if (entry.kind === 'password') return value.password
            const field = value.fields.find(item => item.id === entry.id)
            if (!field) throw new VaultError('STALE_REFERENCE')
            return entry.kind === 'code' ? totpCode(field.value) : field.value
          })
          if (text.some(entry => !entry)) throw new VaultError('UNAVAILABLE')
          control.assertCurrent(); held.assertCurrent(); this.current(epoch)
          const abort = new AbortController(), values = text.map(entry => Buffer.from(entry)), credentialId = value?.id ?? bound.credentialId
          const secret = { credentialId, clear() { abort.abort(); for (const entry of values) entry.fill(0) } }
          this.#activeSecrets.add(secret)
          const detach = held.onInvalidate(() => secret.clear())
          return { values, signal: abort.signal,
            assertCurrent: () => { held.assertCurrent(); this.current(epoch); if (!this.#key || this.#failure || this.#revocations.has(credentialId)) throw new VaultError('LOCKED') },
            release: () => { detach(); secret.clear(); this.#activeSecrets.delete(secret) } }
        } finally { for (const item of payload.credentials) { item.account = ''; item.password = ''; for (const field of item.fields) field.value = '' } }
      })
    }), (entry, effectPossible) => feature ? this.#file.disk.withFeature(feature, () => this.appendAudit(entry, { effectPossible })) : Promise.resolve({ status: 'unavailable', code: 'AUDIT_FAILED', retry: false, retainIsolatedLogin: true }), this.#outcomes).finally(() => feature?.release())
  }
  readAudit(context: object): Promise<AuditRecord[]> {
    this.person(context)
    return this.run(async () => { await this.gates(); await this.open(undefined, true); const { document, key, epoch } = this.unlocked(); const records = await this.#audit.read(document, key, this.#dependencies.accountId); this.current(epoch); return records })
  }
  clearAudit(context: object): Promise<void> {
    this.person(context)
    return this.run(async () => {
      const epoch = this.#epoch
      try {
        await this.gates(); await this.open(undefined, true)
        this.unlocked(); await this.#audit.clear(); this.#outcomes.clear(); this.current(epoch)
        await this.record({ id: randomUUID(), action: 'clear', source: 'local-person', outcome: 'completed' })
      } catch { await this.fail(); throw new VaultError('AUDIT_FAILED') }
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
