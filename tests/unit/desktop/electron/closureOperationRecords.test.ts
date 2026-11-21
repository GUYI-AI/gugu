import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createClosureAuthBarrier } from '../../../../apps/desktop/electron/account-closure/auth-barrier'
import { createClosureOperationRecords, type NativeClosureIdentity } from '../../../../apps/desktop/electron/account-closure/operation-record'

const a = { ownerId: randomUUID(), sessionId: randomUUID() }
const b = { ownerId: randomUUID(), sessionId: randomUUID() }
function fixture() {
  const values = new Map<string, string>(), underAuth = createClosureAuthBarrier()
  let owner: NativeClosureIdentity | null | undefined = a, rejectWrite = false
  const ports = { profileBinding: 'isolated-fixture', identity: async () => owner, underAuth,
    secrets: { getSecret: async (key: string) => values.get(key) ?? null,
      setSecret: async (key: string, value: string) => { if (rejectWrite) throw Error('private storage failure'); values.set(key, value) } } }
  return { values, store: createClosureOperationRecords(ports), restart: () => createClosureOperationRecords(ports),
    as: (next: typeof owner) => { owner = next }, failWrites: () => { rejectWrite = true } }
}
describe('native operation discovery and custody', () => {
  it('atomically captures discoverable metadata and a native random capability without exposing either SID or receipt', async () => {
    const f = fixture(), scope = await f.store.begin()
    expect(f.values.size).toBe(1)
    const protectedRecord = await f.store.readNative(scope)
    expect(protectedRecord.receipt).toMatch(/^[a-f0-9]{64}$/)
    expect(protectedRecord.sessionId).toBe(a.sessionId)
    expect(scope).not.toHaveProperty('receipt'); expect(scope).not.toHaveProperty('sessionId'); expect(scope).not.toHaveProperty('cleanupScopeId')
    expect(protectedRecord.cleanupScopeId).not.toBe(scope.localOperationId)
    expect(await f.restart().discover()).toEqual(scope)
  })
  it('does not create a request-capable operation when persistence fails', async () => {
    const f = fixture(); f.failWrites()
    await expect(f.store.begin()).rejects.toMatchObject({ code: 'closure_storage_unavailable' })
    expect(f.values.size).toBe(0)
    expect(await f.restart().discover()).toBeNull()
  })
  it('returns only approved metadata even if protected storage contains another private field', async () => {
    const f = fixture(), scope = await f.store.begin(), key = [...f.values.keys()][0]!
    const envelope = JSON.parse(f.values.get(key)!)
    envelope.records[a.ownerId].internalOnly = 'internal-protected-fixture'
    f.values.set(key, JSON.stringify(envelope))
    expect(await f.restart().discover()).toEqual(scope)
    expect(JSON.stringify(await f.restart().discover())).not.toContain('internal-protected-fixture')
  })
  it('coalesces concurrent beginnings into one durable original operation', async () => {
    const f = fixture(), scopes = await Promise.all([f.store.begin(), f.store.begin(), f.store.begin()])
    expect(new Set(scopes.map(s => s.localOperationId)).size).toBe(1)
    expect(f.values.size).toBe(1)
  })
  it('discovers after Auth deletion without an ordinary renderer journal', async () => {
    const f = fixture(), scope = await f.store.begin()
    const record = await f.store.readNative(scope)
    await f.store.updateNative(record, next => { next.phase = 'deleted' })
    f.as(null)
    expect(await f.restart().discover()).toMatchObject({ ...scope, phase: 'deleted', revision: 2 })
  })
  it('never exposes A to B and preserves both accounts through checkpoints', async () => {
    const f = fixture(), scopeA = await f.store.begin(), originalA = await f.store.readNative(scopeA)
    f.as(b)
    expect(await f.store.discover()).toBeNull()
    await expect(f.store.readNative(scopeA)).rejects.toMatchObject({ code: 'wrong_local_owner' })
    const scopeB = await f.store.begin()
    const recordB = await f.store.readNative(scopeB)
    await f.store.updateNative(recordB, next => { next.phase = 'registered' })
    f.as(a)
    expect(await f.store.discover()).toEqual(scopeA)
    expect(await f.store.readNative(scopeA)).toEqual(originalA)
  })
  it('can recover an older pending A after B is terminal without ever adopting A while B is current', async () => {
    const f = fixture(), scopeA = await f.store.begin()
    f.as(b); const scopeB = await f.store.begin(); const bRecord = await f.store.readNative(scopeB)
    await f.store.updateNative(bRecord, next => { next.phase = 'finalized'; next.receipt = null })
    expect(await f.store.discover()).toBeNull()
    f.as(null); expect(await f.restart().discover()).toEqual(scopeA)
  })
  it('rejects a stale server callback after a newer checkpoint', async () => {
    const f = fixture(), scope = await f.store.begin(), captured = await f.store.readNative(scope)
    await f.store.updateNative(captured, next => { next.phase = 'registered' })
    await expect(f.store.updateNative(captured, next => { next.phase = 'deleted' })).rejects.toMatchObject({ code: 'scope_conflict' })
    expect((await f.store.discover())?.phase).toBe('registered')
  })
  it('never lets a new SID mutate the original authenticated operation', async () => {
    const f = fixture(), scope = await f.store.begin()
    f.as({ ...a, sessionId: randomUUID() })
    await expect(f.store.begin()).rejects.toMatchObject({ code: 'scope_conflict' })
    await expect(f.store.readNative(scope, true)).rejects.toMatchObject({ code: 'scope_conflict' })
    expect(await f.store.discover()).toEqual(scope)
  })
  it('keeps local completion until finalization and recovers with the removed receipt', async () => {
    const f = fixture(), scope = await f.store.begin()
    let record = await f.store.readNative(scope)
    record = await f.store.updateNative(record, next => { next.phase = 'local-complete' })
    f.as(null)
    expect((await f.restart().discover())?.phase).toBe('local-complete')
    await f.store.updateNative(record, next => { next.phase = 'finalized'; next.receipt = null })
    expect(await f.restart().discover()).toBeNull()
    expect((await f.restart().readNative(scope)).receipt).toBeNull()
  })
  it('refuses corrupted contents, unknown native identity, and invalid immutable changes', async () => {
    const f = fixture(), scope = await f.store.begin(), captured = await f.store.readNative(scope)
    await expect(f.store.updateNative(captured, next => { next.ownerId = b.ownerId })).rejects.toMatchObject({ code: 'scope_conflict' })
    f.as(undefined)
    await expect(f.store.discover()).rejects.toMatchObject({ code: 'closure_storage_unavailable' })
    f.as(a)
    f.values.set([...f.values.keys()][0]!, '{broken')
    await expect(f.store.discover()).rejects.toMatchObject({ code: 'closure_storage_unavailable' })
  })
})
