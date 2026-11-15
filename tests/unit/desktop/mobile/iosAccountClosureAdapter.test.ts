import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountClosureNative, AccountClosureResult, AccountClosureScope } from '../../../../apps/desktop/src/platform/accountClosure'
import { composePhoneAccountClosure, type AccountClosureRequestActions } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureComposition'
import { createAccountClosureJournal } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureJournal'
import type { PhoneCloseAcknowledgement } from '../../../../apps/desktop/src/components/settings/accountDeletion/phoneAccountClosureFlow'
import { createIOSAccountClosureFlow } from '../../../../apps/desktop/src/mobile/ios-runtime/iosAccountClosureAdapter'
const ios = vi.hoisted(() => ({ owner: null as string | null, prepare: vi.fn(), retire: vi.fn(), native: { receipt: { put: vi.fn(), get: vi.fn(), remove: vi.fn() }, eraseLocal: vi.fn() } }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ios.owner ? { user: { id: ios.owner } } : null, observeRendererSession: () => () => {} }))
vi.mock('../../../../apps/desktop/src/platform/iosAccountClosure', () => ({ nativeIOSAccountClosure: ios.native }))
vi.mock('../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerClient', () => ({ prepareIOSSignOut: ios.prepare, iosOwnerClient: { retire: ios.retire } }))
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002'
type CloseInput = Parameters<AccountClosureRequestActions['closeAccount']>[0]
const proof = 'synthetic-private-receipt-A'
const confirmed = { confirmed: true } as const
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const metadata = new Map<string, string>(), records = new Map<string, { receipt: string | null; erased: boolean }>()
  const data = new Map([[A, 'A-private-state'], [B, 'B-unchanged-state']])
  const key = (scope: AccountClosureScope) => `${scope.ownerId}:${scope.localOperationId}`
  let owner: string | null = A
  const journal = createAccountClosureJournal({ getItem: name => metadata.get(name) ?? null, setItem: (name, value) => { metadata.set(name, value) }, removeItem: name => { metadata.delete(name) } })
  const native = {
    receipt: {
      put: vi.fn(async (scope: AccountClosureScope, receipt: string) => {
        const previous = records.get(key(scope))
        if (previous && previous.receipt !== receipt) throw new Error('scope_conflict')
        records.set(key(scope), { receipt, erased: previous?.erased ?? false })
      }),
      get: vi.fn(async (scope: AccountClosureScope) => { const value = records.get(key(scope)); if (!value) throw new Error('closure_context_missing'); return value.receipt }),
      remove: vi.fn(async (scope: AccountClosureScope) => { const value = records.get(key(scope)); if (!value) throw new Error('closure_context_missing'); value.receipt = null }),
    },
    eraseLocal: vi.fn(async (scope: AccountClosureScope): Promise<AccountClosureResult> => {
      const value = records.get(key(scope)); if (!value) throw new Error('closure_context_missing')
      if (!value.erased && value.receipt === null) throw new Error('receipt_missing')
      value.erased = true; data.delete(scope.ownerId)
      return { status: 'complete', retainedUnattributed: [] }
    }),
  } satisfies AccountClosureNative
  const requests: AccountClosureRequestActions = {
    closeAccount: vi.fn(async (input: CloseInput): Promise<PhoneCloseAcknowledgement> => { await input.captureReceipt(proof); return { status: 'deleted' } }),
    readResult: vi.fn(async (): Promise<PhoneCloseAcknowledgement> => ({ status: 'deleted' })),
  }
  const stopAgent = vi.fn(async () => confirmed), removeDevice = vi.fn(async () => confirmed)
  const open = () => composePhoneAccountClosure({ ownerId: A, platform: 'ios', currentOwnerId: () => owner, native, journal, requests, stopAgent, removeDevice })
  return { metadata, records, data, journal, native, requests, stopAgent, removeDevice, open, owner: (value: string | null) => { owner = value } }
}
beforeEach(() => { vi.clearAllMocks(); ios.owner = A; ios.prepare.mockResolvedValue(undefined); ios.retire.mockResolvedValue(undefined) })
afterEach(() => vi.useRealTimers())
describe('iOS account closure composition', () => {
  it('uses explicit iOS preparation and retirement acknowledgements, then erases only A', async () => {
    const f = fixture(), b = { ownerId: B, localOperationId: 'operation-B' }
    await f.journal.write(b); await f.native.receipt.put(b, 'synthetic-B-proof')
    const before = JSON.stringify([...f.metadata]), beforeB = JSON.stringify([...f.records])
    ios.native.receipt.put.mockImplementation(f.native.receipt.put)
    ios.native.receipt.get.mockImplementation(f.native.receipt.get)
    ios.native.receipt.remove.mockImplementation(f.native.receipt.remove)
    ios.native.eraseLocal.mockImplementation(f.native.eraseLocal)
    const flow = await createIOSAccountClosureFlow({ ownerId: A, requests: f.requests, journal: f.journal })
    expect(ios.prepare).not.toHaveBeenCalled(); await flow.start()
    expect(ios.prepare).toHaveBeenCalledExactlyOnceWith(A); expect(ios.retire).toHaveBeenCalledExactlyOnceWith(A)
    expect(ios.prepare.mock.invocationCallOrder[0]).toBeLessThan(ios.retire.mock.invocationCallOrder[0]!)
    expect(flow.getSnapshot()).toEqual({ status: 'closed' })
    expect(f.data.has(A)).toBe(false); expect(f.data.get(B)).toBe('B-unchanged-state')
    expect(JSON.stringify([...f.metadata])).toBe(before)
    expect(JSON.stringify([...f.records].filter(([key]) => key.startsWith(B)))).toBe(beforeB)
    expect(JSON.stringify([...f.metadata])).not.toContain(proof)
  })
  it.each(['prepare', 'retire'] as const)('halts before submission when native %s fails', async phase => {
    const f = fixture(); ios[phase].mockRejectedValue(new Error('private native detail'))
    const flow = await createIOSAccountClosureFlow({ ownerId: A, requests: f.requests, journal: f.journal }); await flow.start()
    expect(flow.getSnapshot()).toMatchObject({ status: 'failed', phase: phase === 'prepare' ? 'stop-agent' : 'remove-device' })
    expect(f.requests.closeAccount).not.toHaveBeenCalled(); expect(f.native.receipt.put).not.toHaveBeenCalled()
    if (phase === 'prepare') expect(ios.retire).not.toHaveBeenCalled()
    expect(JSON.stringify(flow.getSnapshot())).not.toContain('private')
  })
  it('refuses a different account after asynchronous preparation', async () => {
    const f = fixture(), waiting = deferred<void>(); ios.prepare.mockImplementation(() => waiting.promise)
    const flow = await createIOSAccountClosureFlow({ ownerId: A, requests: f.requests, journal: f.journal }), work = flow.start()
    ios.owner = B; waiting.resolve(); await work
    expect(flow.getSnapshot()).toMatchObject({ status: 'failed', phase: 'stop-agent' }); expect(ios.retire).not.toHaveBeenCalled(); expect(f.requests.closeAccount).not.toHaveBeenCalled()
  })
  it('writes scope before submission and waits for encrypted capture before accepting a result', async () => {
    const f = fixture(), gate = deferred<void>(); const original = f.native.receipt.put.getMockImplementation()!
    f.native.receipt.put.mockImplementation(async (scope, value) => { await gate.promise; await original(scope, value) })
    f.requests.closeAccount = vi.fn(async (input: CloseInput): Promise<PhoneCloseAcknowledgement> => { expect(await f.journal.read(A)).toEqual(input.scope); void input.captureReceipt(proof); return { status: 'deleted' } })
    const flow = await f.open(), work = flow.start(); void flow.start()
    await vi.waitFor(() => expect(f.native.receipt.put).toHaveBeenCalledTimes(1))
    expect(f.native.eraseLocal).not.toHaveBeenCalled(); expect(flow.getSnapshot()).toMatchObject({ status: 'running', phase: 'close-account' })
    gate.resolve(); await work
    expect(flow.getSnapshot()).toEqual({ status: 'closed' }); expect(f.requests.closeAccount).toHaveBeenCalledTimes(1)
  })
  it('restores one operation and queries the saved receipt without replaying cleanup or close', async () => {
    const f = fixture()
    f.requests.closeAccount = vi.fn(async (input: CloseInput): Promise<PhoneCloseAcknowledgement> => { await input.captureReceipt(proof); throw new Error('lost response') })
    const first = await f.open(); await first.start(); const scope = await f.journal.read(A)
    expect(first.getSnapshot()).toMatchObject({ status: 'unconfirmed' }); f.owner(null)
    const reopened = await f.open()
    expect(reopened.getSnapshot()).toEqual({ status: 'closed' })
    expect(f.requests.closeAccount).toHaveBeenCalledTimes(1); expect(f.stopAgent).toHaveBeenCalledTimes(1); expect(f.removeDevice).toHaveBeenCalledTimes(1)
    expect(f.requests.readResult).toHaveBeenCalledExactlyOnceWith({ scope, receipt: proof })
  })
  it('does not submit, read remotely or erase after an interrupted request without captured proof', async () => {
    const f = fixture(); f.requests.closeAccount = vi.fn(async (): Promise<PhoneCloseAcknowledgement> => { throw new Error('unknown before capture') })
    const first = await f.open(); await first.start(); const scope = await f.journal.read(A); await first.retry()
    const reopened = await f.open()
    expect(reopened.getSnapshot()).toMatchObject({ status: 'unconfirmed' }); expect(await f.journal.read(A)).toEqual(scope)
    expect(f.requests.closeAccount).toHaveBeenCalledTimes(1); expect(f.requests.readResult).not.toHaveBeenCalled(); expect(f.native.eraseLocal).not.toHaveBeenCalled()
  })
  it('does not expose A recovery to a different active account', async () => {
    const f = fixture(); f.requests.closeAccount = vi.fn(async (input: CloseInput): Promise<PhoneCloseAcknowledgement> => { await input.captureReceipt(proof); return { status: 'processing' } })
    const first = await f.open(); await first.start(); const reads = f.native.receipt.get.mock.calls.length
    f.owner(B)
    await expect(f.open()).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(f.native.receipt.get).toHaveBeenCalledTimes(reads); expect(f.requests.readResult).not.toHaveBeenCalled(); expect(f.data.get(B)).toBe('B-unchanged-state')
  })
  it('does not accept a terminal response when protected capture fails', async () => {
    const f = fixture(); f.native.receipt.put.mockRejectedValue(new Error('closure_storage_unavailable'))
    const flow = await f.open(); await flow.start()
    expect(flow.getSnapshot()).toMatchObject({ status: 'unconfirmed' }); expect(f.native.eraseLocal).not.toHaveBeenCalled(); expect(await f.journal.read(A)).not.toBeNull()
  })
  it('refuses to submit when stable scope storage fails', async () => {
    const f = fixture(); vi.spyOn(f.journal, 'write').mockRejectedValue(new Error('metadata unavailable'))
    const flow = await f.open(); await flow.start()
    expect(f.requests.closeAccount).not.toHaveBeenCalled(); expect(f.native.receipt.put).not.toHaveBeenCalled(); expect(f.native.eraseLocal).not.toHaveBeenCalled()
  })
  it('retries only an explicit retry_wait and preserves the same operation and proof', async () => {
    const f = fixture(); let calls = 0; let original: AccountClosureScope | undefined
    f.requests.closeAccount = vi.fn(async (input: CloseInput): Promise<PhoneCloseAcknowledgement> => {
      calls += 1
      if (calls === 1) { original = input.scope; await input.captureReceipt(proof); return { status: 'retry_wait', canRetry: true } }
      expect(input.scope).toEqual(original); expect(input.receipt).toBe(proof); return { status: 'deleted' }
    })
    const flow = await f.open(); await flow.start(); await flow.retry()
    expect(flow.getSnapshot()).toEqual({ status: 'closed' }); expect(f.requests.closeAccount).toHaveBeenCalledTimes(2); expect(f.stopAgent).toHaveBeenCalledTimes(1)
  })
  it('preserves the no-receipt guard if receipt removal precedes interrupted journal removal', async () => {
    const f = fixture(); vi.spyOn(f.journal, 'remove').mockRejectedValue(new Error('interrupted metadata removal'))
    const first = await f.open(); await first.start(); expect(first.getSnapshot()).toMatchObject({ status: 'local-pending' })
    const writes = f.native.eraseLocal.mock.calls.length, submits = vi.mocked(f.requests.closeAccount).mock.calls.length
    const reopened = await f.open()
    expect(reopened.getSnapshot()).toMatchObject({ status: 'unconfirmed' }); expect(f.native.eraseLocal).toHaveBeenCalledTimes(writes); expect(f.requests.closeAccount).toHaveBeenCalledTimes(submits)
  })
  it('does not publish success or erase from a cancelled operation with late capture', async () => {
    const f = fixture(), gate = deferred<void>(); const original = f.native.receipt.put.getMockImplementation()!
    f.native.receipt.put.mockImplementation(async (scope, value) => { await gate.promise; await original(scope, value) })
    const flow = await f.open(), work = flow.start()
    await vi.waitFor(() => expect(f.native.receipt.put).toHaveBeenCalledTimes(1)); flow.cancel(); gate.resolve(); await work
    expect(flow.getSnapshot()).toMatchObject({ status: 'unconfirmed' }); expect(f.native.eraseLocal).not.toHaveBeenCalled()
    expect((await f.open()).getSnapshot()).toEqual({ status: 'closed' }); expect(f.requests.closeAccount).toHaveBeenCalledTimes(1)
  })
})
