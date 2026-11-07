import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { canary, committed, fixture, request, bytesUnder } from './management-fixture'
import { VaultDisk } from '../../../apps/desktop/electron/password-vault/disk'
import { VaultError } from '../../../apps/desktop/electron/password-vault/contracts'
import { VaultFile } from '../../../apps/desktop/electron/password-vault/vault-file'

describe('management request withdrawal and durable recovery', () => {
  it.each(['create', 'edit', 'delete'] as const)('prevents %s entry changes when withdrawn while waiting for file protection', async action => {
    const f = await fixture(), original = committed(await f.port.create(f.person, randomUUID(), canary(), request().guard)), before = await f.payload(), r = request()
    let proceed!: () => void
    vi.mocked(f.dependencies.assertPrivateStorageReady).mockImplementationOnce(() => new Promise(resolve => { proceed = resolve }))
    const attempt = action === 'create' ? f.port.create(f.person, randomUUID(), canary(), r.guard)
      : action === 'edit' ? f.port.edit(f.person, randomUUID(), original.reference, { password: randomUUID() }, r.guard)
        : f.port.delete(f.person, randomUUID(), original.reference, r.guard)
    await vi.waitFor(() => expect(typeof proceed).toBe('function')); r.controller.abort(); proceed()
    expect((await attempt).status).toBe('not_committed')
    expect(JSON.stringify((await f.payload()).credentials) === JSON.stringify(before.credentials)).toBe(true)
  })
  it.each(['expire', 'lock'] as const)('prevents entry change during pending cleanup on %s', async kind => {
    const f = await fixture(), saved = committed(await f.port.create(f.person, randomUUID(), canary(), request().guard)), before = await f.payload(), r = request()
    let proceed!: () => void
    const opened = vi.spyOn(VaultFile.prototype, 'payload')
    vi.mocked(f.dependencies.invalidate).mockImplementationOnce(() => new Promise(resolve => { proceed = resolve }))
    const attempt = f.port.edit(f.person, randomUUID(), saved.reference, { description: 'Must not commit' }, r.guard)
    await vi.waitFor(() => { expect(typeof proceed).toBe('function'); expect(opened).toHaveBeenCalled() })
    const locked = kind === 'lock' ? f.vault.lock() : undefined
    if (kind === 'expire') r.controller.abort()
    proceed(); expect((await attempt).status).toBe('not_committed'); await locked
    expect(JSON.stringify((await f.payload()).credentials) === JSON.stringify(before.credentials)).toBe(true)
  })
  it.each(['signal', 'sync-assert'] as const)('checks %s again after the pre-commit audit and writes no entry', async kind => {
    const f = await fixture(), r = request(), input = canary(), operationId = randomUUID(), original = VaultDisk.prototype.write
    let invalid = false
    r.check.mockImplementation(() => { if (invalid) throw new VaultError('CANCELLED') })
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      await original.call(this, path, bytes)
      if (path.includes('/audit/')) { if (kind === 'signal') r.controller.abort(); else invalid = true }
    })
    const outcome = await f.port.create(f.person, operationId, input, r.guard)
    expect(outcome.status).toBe('not_committed'); expect((await f.payload()).credentials.length).toBe(0)
    vi.restoreAllMocks(); await f.vault.unlock(f.person)
    expect(await f.port.operationResult(f.person, operationId)).toEqual({ status: 'pending' })
  })
  it('rechecks the request during disk checks between entry-write preparation and final rename', async () => {
    const f = await fixture(), r = request(), original = VaultDisk.prototype.write, operationId = randomUUID()
    let entryWrites = 0, deny = false
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.endsWith('/vault.json') && ++entryWrites === 2) deny = true
      return original.call(this, path, bytes)
    })
    vi.mocked(f.dependencies.assertPrivateStorageReady).mockImplementation(async () => { if (deny) r.controller.abort() })
    // The entry write has been issued but is stopped before replacement: the receipt must stay conservative.
    expect((await f.port.create(f.person, operationId, canary(), r.guard)).status).toBe('uncertain')
    expect((await f.payload()).credentials.length).toBe(0)
  })
  it.each(['commit-response', 'post-audit'] as const)('recovers %s loss from the original encrypted ledger, read-only and without a repeated effect', async phase => {
    const f = await fixture(), input = canary(), id = randomUUID(), original = VaultDisk.prototype.write
    let vaultWrites = 0, auditWrites = 0
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.endsWith('/vault.json')) vaultWrites++
      if (path.includes('/audit/')) auditWrites++
      if (phase === 'post-audit' && path.includes('/audit/') && auditWrites === 2) throw new Error(input.password)
      await original.call(this, path, bytes)
      if (phase === 'commit-response' && path.endsWith('/vault.json') && vaultWrites === 2) throw new Error(input.fields![0].value)
    })
    const outcome = await f.port.create(f.person, id, input, request().guard)
    expect(outcome.status).toBe('uncertain'); expect(JSON.stringify(outcome).includes(input.password)).toBe(false)
    vi.restoreAllMocks(); await f.vault.dispose()
    const restarted = f.construct(); await restarted.unlock(f.person)
    const before = await bytesUnder(f.root), write = vi.spyOn(VaultDisk.prototype, 'write')
    const recovery = await restarted.managementPort.operationResult(f.person, id)
    expect(recovery.status).toBe('committed'); expect(write).not.toHaveBeenCalled()
    expect(JSON.stringify((await bytesUnder(f.root)).map(bytes => bytes.toString('base64'))) === JSON.stringify(before.map(bytes => bytes.toString('base64')))).toBe(true)
    expect((await restarted.managementPort.query(f.agent)).length).toBe(1)
    const again = committed(await restarted.managementPort.create(f.person, id, input, request().guard))
    expect(again.reference.version).toBe(1); expect(again.fieldNames).toEqual(['API Key', 'TOTP seed'])
    expect((await restarted.managementPort.query(f.agent)).length).toBe(1)
    expect((await restarted.readAudit(f.person)).filter(event => event.action === 'add' && event.outcome === 'completed').length).toBe(1)
  })
  it('keeps not-committed pending input bound to the same operation across a fresh unlock and rejects changed bodies', async () => {
    const f = await fixture(), input = canary(), id = randomUUID(), original = VaultDisk.prototype.write
    vi.spyOn(VaultDisk.prototype, 'write').mockImplementation(async function (this: VaultDisk, path, bytes) {
      if (path.includes('/audit/')) throw new VaultError('STORAGE_FAILED')
      return original.call(this, path, bytes)
    })
    expect(await f.port.create(f.person, id, input, request().guard)).toMatchObject({ status: 'not_committed', code: 'AUDIT_FAILED' })
    expect((await f.payload()).credentials.length).toBe(0)
    vi.restoreAllMocks(); await f.vault.unlock(f.person)
    expect(await f.port.operationResult(f.person, id)).toEqual({ status: 'pending' })
    expect(await f.port.create(f.person, id, { ...input, description: 'different' }, request().guard)).toMatchObject({ status: 'not_committed', code: 'INVALID_INPUT' })
    committed(await f.port.create(f.person, id, input, request().guard))
    expect((await f.port.query(f.agent)).length).toBe(1)
  })
  it('deletes once, invalidates a waiting use synchronously, and recovers the original result after subsequent changes', async () => {
    const f = await fixture(), saved = committed(await f.port.create(f.person, randomUUID(), canary(), request().guard)), id = randomUUID(), before = await f.port.query(f.agent)
    let revoked = false, proceed!: () => void
    vi.mocked(f.dependencies.invalidate).mockImplementationOnce(async event => {
      if (event.reason === 'delete' && event.credentialId === saved.reference.id) revoked = true
      await new Promise<void>(resolve => { proceed = resolve })
    })
    const removing = f.port.delete(f.person, id, saved.reference, request().guard)
    expect(revoked).toBe(true)
    await vi.waitFor(() => expect(typeof proceed).toBe('function')); expect((await f.payload()).credentials.length).toBe(1)
    proceed(); const removed = committed(await removing)
    expect(removed.fieldNames).toEqual(before[0].fieldNames)
    expect((await f.vault.checkReference(f.agent, saved.reference)).status).toBe('invalidated')
    expect(committed(await f.port.delete(f.person, id, saved.reference, request().guard))).toEqual(removed)
    expect(await f.port.operationResult(f.person, id)).toEqual({ status: 'committed', result: removed })
    expect((await f.port.query(f.agent)).length).toBe(0)
  })
  it('does not report a previous committed operation as not_committed when a later retry carries an expired guard', async () => {
    const f = await fixture(), input = canary(), id = randomUUID(), saved = committed(await f.port.create(f.person, id, input, request().guard))
    const r = request(); r.controller.abort()
    expect((await f.port.create(f.person, id, input, r.guard)).status).toBe('uncertain')
    expect(await f.port.operationResult(f.person, id)).toEqual({ status: 'committed', result: saved })
    await f.vault.lock()
    // The caller must unlock/read the original ledger; a locked vault is no evidence of non-commit.
    expect((await f.port.create(f.person, id, input, request().guard)).status).toBe('uncertain')
  })
  it('retains original result field names after later edits and deletion instead of returning the current entry', async () => {
    const f = await fixture(), id = randomUUID(), saved = committed(await f.port.create(f.person, id, canary(), request().guard))
    const field = (await f.port.describeEdit(f.person, saved.reference)).fields[0]
    const edited = committed(await f.port.edit(f.person, randomUUID(), saved.reference, { fields: [{ id: field.id, name: 'Later name' }] }, request().guard))
    committed(await f.port.delete(f.person, randomUUID(), edited.reference, request().guard))
    expect(await f.port.operationResult(f.person, id)).toEqual({ status: 'committed', result: saved })
  })
  it('retains the captured guard assertion when its dependency object is replaced during an await', async () => {
    const f = await fixture(), r = request()
    let proceed!: () => void, invalid = false
    r.check.mockImplementation(() => { if (invalid) throw new VaultError('CANCELLED') })
    vi.mocked(f.dependencies.assertPrivateStorageReady).mockImplementationOnce(() => new Promise(resolve => { proceed = resolve }))
    const attempt = f.port.create(f.person, randomUUID(), canary(), r.guard)
    await vi.waitFor(() => expect(typeof proceed).toBe('function'))
    r.guard.assertCurrent = () => undefined; invalid = true; proceed()
    expect((await attempt).status).toBe('not_committed'); expect((await f.payload()).credentials.length).toBe(0)
  })
  it.each(['missing', 'aborted', 'async-resolve', 'async-reject', 'replacement'] as const)('rejects %s request guards without entry writes or unhandled rejection', async kind => {
    const f = await fixture(), r = request(), original = r.guard.assertCurrent, unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const guard = kind === 'missing' ? undefined : r.guard
      if (kind === 'aborted') r.controller.abort()
      if (kind === 'async-resolve') r.guard.assertCurrent = async () => undefined
      if (kind === 'async-reject') r.guard.assertCurrent = async () => { throw new Error('synthetic private failure') }
      if (kind === 'replacement') {
        r.check.mockImplementation(() => { r.guard.assertCurrent = () => undefined; throw new VaultError('UNAVAILABLE') })
      }
      expect((await f.port.create(f.person, randomUUID(), canary(), guard!)).status).toBe('not_committed')
      await new Promise(resolve => setImmediate(resolve)); expect(unhandled).not.toHaveBeenCalled()
      expect((await f.payload()).credentials.length).toBe(0)
    } finally { process.off('unhandledRejection', unhandled); r.guard.assertCurrent = original }
  })
})
