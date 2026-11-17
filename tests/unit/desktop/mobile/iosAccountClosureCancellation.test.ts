import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountClosureNative, AccountClosureScope } from '../../../../apps/desktop/src/platform/accountClosure'
import type { AccountClosureJournal } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureLocalCleanup'
import type { AccountClosureRequestActions } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureComposition'
import type { PhoneCloseAcknowledgement } from '../../../../apps/desktop/src/components/settings/accountDeletion/phoneAccountClosureFlow'

const ios = vi.hoisted(() => ({ owner: '11111111-1111-4111-8111-111111111111' as string | null,
  prepare: vi.fn(), retire: vi.fn(), cancel: vi.fn(),
  native: { receipt: { put: vi.fn(), get: vi.fn(), remove: vi.fn() }, eraseLocal: vi.fn() } }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ios.owner ? { user: { id: ios.owner } } : null }))
vi.mock('../../../../apps/desktop/src/platform/iosAccountClosure', () => ({ nativeIOSAccountClosure: ios.native }))
vi.mock('../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerClient', () => ({
  prepareIOSSignOut: ios.prepare, cancelIOSSignOut: ios.cancel, iosOwnerClient: { retire: ios.retire },
}))
import { createIOSAccountClosureFlow } from '../../../../apps/desktop/src/mobile/ios-runtime/iosAccountClosureAdapter'

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
function fixture(initial: PhoneCloseAcknowledgement = { status: 'processing' }) {
  const events: string[] = [], receipts = new Map<string, string>(), journals = new Map<string, AccountClosureScope>()
  const data = new Map([[A, 'A-state'], [B, 'B-state']])
  let result = initial, sealed = false, running = true
  const key = (scope: AccountClosureScope) => `${scope.ownerId}:${scope.localOperationId}`
  const native: AccountClosureNative = {
    receipt: {
      put: vi.fn(async (scope, receipt) => { events.push('put'); receipts.set(key(scope), receipt) }),
      get: vi.fn(async scope => receipts.get(key(scope)) ?? null),
      remove: vi.fn(async scope => { events.push('remove'); receipts.delete(key(scope)) }),
    },
    eraseLocal: vi.fn(async scope => { events.push('erase'); data.delete(scope.ownerId); return { status: 'complete' as const, retainedUnattributed: [] } }),
  }
  const journal: AccountClosureJournal = {
    write: vi.fn(async scope => { journals.set(scope.ownerId, scope) }),
    read: vi.fn(async owner => journals.get(owner) ?? null),
    remove: vi.fn(async scope => { events.push('journal-remove'); journals.delete(scope.ownerId) }),
  }
  const requests: AccountClosureRequestActions = {
    closeAccount: vi.fn(async input => { events.push('close'); await input.captureReceipt('synthetic-protected-receipt'); return result }),
    readResult: vi.fn(async () => { events.push('read'); return result }),
  }
  ios.prepare.mockImplementation(async () => { events.push('prepare'); running = false; sealed = true })
  ios.retire.mockImplementation(async () => { events.push('retire') })
  ios.cancel.mockImplementation(async () => { events.push('cancel'); sealed = false })
  ios.native.receipt.put.mockImplementation(native.receipt.put)
  ios.native.receipt.get.mockImplementation(native.receipt.get)
  ios.native.receipt.remove.mockImplementation(native.receipt.remove)
  ios.native.eraseLocal.mockImplementation(native.eraseLocal)
  return { events, native, journal, requests, data, receipts, journals,
    sealed: () => sealed, running: () => running, setResult: (value: PhoneCloseAcknowledgement) => { result = value },
    create: () => createIOSAccountClosureFlow({ ownerId: A, requests, journal }),
  }
}
beforeEach(() => { vi.resetAllMocks(); ios.owner = A })
afterEach(() => vi.useRealTimers())

describe('iOS closure preparation finalization', () => {
  it.each(['failed', 'expired'] as const)('%s removes the receipt before cancellation and keeps the Agent stopped', async status => {
    const f = fixture({ status }), flow = await f.create(); await flow.start()
    expect(f.events).toEqual(['prepare', 'retire', 'close', 'put', 'remove', 'cancel', 'journal-remove'])
    expect(ios.cancel).toHaveBeenCalledExactlyOnceWith(A, expect.any(String))
    expect(f.native.eraseLocal).not.toHaveBeenCalled(); expect(f.data.get(B)).toBe('B-state')
    expect(f.sealed()).toBe(false); expect(f.running()).toBe(false)
    expect(flow.getSnapshot()).toEqual({ status: 'failed', phase: 'close-account', canRetry: false })
  })

  it.each([{ status: 'processing' }, { status: 'retry_wait', canRetry: true }] as const)('retains the seal for pending $status', async result => {
    const f = fixture(result), flow = await f.create(); await flow.start()
    expect(f.sealed()).toBe(true); expect(f.running()).toBe(false)
    expect(ios.cancel).not.toHaveBeenCalled(); expect(f.native.receipt.remove).not.toHaveBeenCalled()
  })

  it('keeps the seal and receipt when the close response is lost', async () => {
    const f = fixture()
    vi.mocked(f.requests.closeAccount).mockImplementation(async input => { await input.captureReceipt('synthetic-protected-receipt'); throw new Error('lost response') })
    const flow = await f.create(); await flow.start()
    expect(flow.getSnapshot().status).toBe('unconfirmed'); expect(f.sealed()).toBe(true)
    expect(ios.cancel).not.toHaveBeenCalled(); expect(f.native.receipt.remove).not.toHaveBeenCalled()
  })

  it('keeps the seal through all five pending local erase attempts', async () => {
    vi.useFakeTimers(); const f = fixture({ status: 'deleted' })
    vi.mocked(f.native.eraseLocal).mockResolvedValue({ status: 'pending', retainedUnattributed: [] })
    const flow = await f.create(), work = flow.start(); await vi.runAllTimersAsync(); await work
    expect(flow.getSnapshot().status).toBe('local-pending'); expect(f.native.eraseLocal).toHaveBeenCalledTimes(5)
    expect(f.sealed()).toBe(true); expect(ios.cancel).not.toHaveBeenCalled(); expect(f.native.receipt.remove).not.toHaveBeenCalled()
  })

  it('does not cancel a deleted result even after receipt removal', async () => {
    const f = fixture({ status: 'deleted' }), flow = await f.create(); await flow.start()
    expect(flow.getSnapshot().status).toBe('closed'); expect(f.native.receipt.remove).toHaveBeenCalledOnce()
    expect(ios.cancel).not.toHaveBeenCalled(); expect(f.sealed()).toBe(true); expect(f.running()).toBe(false)
    expect(f.data.has(A)).toBe(false); expect(f.data.get(B)).toBe('B-state')
  })

  it.each(['failed', 'expired'] as const)('%s cancellation failure is rejected while failed custody stays saved', async status => {
    const f = fixture({ status }), error = Object.assign(new Error('cancel failed'), { code: 'stale_context' })
    ios.cancel.mockRejectedValue(error)
    const flow = await f.create(); await expect(flow.start()).rejects.toBe(error)
    expect(flow.getSnapshot().status).toBe('failed'); expect(f.sealed()).toBe(true); expect(f.running()).toBe(false)
    expect(f.native.receipt.remove).toHaveBeenCalledOnce(); expect(f.journal.remove).not.toHaveBeenCalled(); expect(f.journals.has(A)).toBe(true)
  })

  it('never cancels if receipt removal fails', async () => {
    const f = fixture({ status: 'failed' }); ios.native.receipt.remove.mockRejectedValue(new Error('protected write failed'))
    const flow = await f.create(); await flow.start()
    expect(ios.cancel).not.toHaveBeenCalled(); expect(f.journal.remove).not.toHaveBeenCalled()
    expect(f.sealed()).toBe(true); expect(f.journals.has(A)).toBe(true)
  })

  it('waits for the protected remove acknowledgement before cancellation', async () => {
    const f = fixture({ status: 'failed' })
    let finish!: () => void
    const removed = new Promise<void>(resolve => { finish = resolve })
    ios.native.receipt.remove.mockImplementation(async scope => { await removed; await f.native.receipt.remove(scope) })
    const flow = await f.create(), work = flow.start()
    await vi.waitFor(() => expect(ios.native.receipt.remove).toHaveBeenCalledOnce())
    expect(ios.cancel).not.toHaveBeenCalled(); expect(f.sealed()).toBe(true)
    finish(); await work
    expect(ios.cancel).toHaveBeenCalledOnce(); expect(f.sealed()).toBe(false)
  })

  it.each(['failed', 'expired'] as const)('restores %s through readResult without resubmitting or preparing again', async status => {
    const f = fixture(), first = await f.create(); await first.start(); const saved = f.journals.get(A)
    f.events.length = 0; f.setResult({ status })
    const restored = await f.create()
    expect(f.events).toEqual(['read', 'remove', 'cancel', 'journal-remove'])
    expect(ios.cancel).toHaveBeenCalledExactlyOnceWith(A, saved!.localOperationId)
    expect(ios.prepare).toHaveBeenCalledOnce(); expect(ios.retire).toHaveBeenCalledOnce(); expect(f.requests.closeAccount).toHaveBeenCalledOnce()
    expect(restored.getSnapshot().status).toBe('failed'); expect(f.sealed()).toBe(false); expect(f.running()).toBe(false)
  })

  it('restores deleted completion without cancellation or live-auth cleanup replay', async () => {
    const f = fixture(), first = await f.create(); await first.start(); f.setResult({ status: 'deleted' })
    const restored = await f.create()
    expect(restored.getSnapshot().status).toBe('closed'); expect(ios.cancel).not.toHaveBeenCalled()
    expect(ios.prepare).toHaveBeenCalledOnce(); expect(ios.retire).toHaveBeenCalledOnce(); expect(f.requests.closeAccount).toHaveBeenCalledOnce()
  })

  it('rejects a cancellation failure encountered during restore', async () => {
    const f = fixture(), first = await f.create(); await first.start(); f.setResult({ status: 'expired' })
    const error = Object.assign(new Error('cancel failed'), { code: 'stale_context' }); ios.cancel.mockRejectedValue(error)
    await expect(f.create()).rejects.toBe(error); expect(f.journals.has(A)).toBe(true); expect(f.sealed()).toBe(true)
    expect(f.requests.closeAccount).toHaveBeenCalledOnce()
  })

  it('does not resubmit after native preparation or retirement fails', async () => {
    const f = fixture({ status: 'failed' }); ios.retire.mockRejectedValue(new Error('retire failed'))
    const flow = await f.create(); await flow.start(); await flow.retry()
    expect(flow.getSnapshot()).toEqual({ status: 'failed', phase: 'remove-device', canRetry: false })
    expect(f.requests.closeAccount).not.toHaveBeenCalled(); expect(ios.cancel).not.toHaveBeenCalled()
  })

  it('refuses another active account before touching either preparation or receipt', async () => {
    const f = fixture({ status: 'failed' }); ios.owner = B
    await expect(f.create()).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(f.events).toEqual([]); expect(f.data.get(B)).toBe('B-state'); expect(ios.cancel).not.toHaveBeenCalled()
  })

  it('checks a pending submission to failed without starting another close request', async () => {
    const f = fixture(), flow = await f.create(); await flow.start(); f.setResult({ status: 'failed' }); await flow.checkResult()
    expect(f.requests.closeAccount).toHaveBeenCalledOnce(); expect(f.requests.readResult).toHaveBeenCalledOnce()
    expect(ios.cancel).toHaveBeenCalledOnce(); expect(f.sealed()).toBe(false)
  })

  it.each(['retry', 'checkResult'] as const)('surfaces cancellation failure from %s', async action => {
    const f = fixture(action === 'retry' ? { status: 'retry_wait', canRetry: true } : { status: 'processing' })
    const flow = await f.create(); await flow.start(); f.setResult({ status: 'failed' })
    const error = Object.assign(new Error('cancel failed'), { code: 'stale_context' }); ios.cancel.mockRejectedValue(error)
    await expect(flow[action]()).rejects.toBe(error)
    expect(flow.getSnapshot().status).toBe('failed'); expect(f.sealed()).toBe(true)
    expect(ios.prepare).toHaveBeenCalledOnce(); expect(ios.retire).toHaveBeenCalledOnce()
  })

  it('does not turn a recorded cancellation failure into success through retryLocal', async () => {
    const f = fixture({ status: 'expired' }), error = Object.assign(new Error('cancel failed'), { code: 'stale_context' })
    ios.cancel.mockRejectedValue(error)
    const flow = await f.create(); await expect(flow.start()).rejects.toBe(error)
    await expect(flow.retryLocal()).rejects.toBe(error)
    expect(ios.cancel).toHaveBeenCalledOnce(); expect(f.requests.closeAccount).toHaveBeenCalledOnce()
    expect(flow.getSnapshot().status).toBe('failed')
  })

  it('does not infer cancellation or resubmit after restart with a removed receipt and failed cancellation', async () => {
    const f = fixture({ status: 'failed' }), error = Object.assign(new Error('cancel failed'), { code: 'stale_context' })
    ios.cancel.mockRejectedValue(error)
    const first = await f.create(); await expect(first.start()).rejects.toBe(error)
    const reopened = await f.create()
    expect(reopened.getSnapshot().status).toBe('unconfirmed'); expect(f.sealed()).toBe(true); expect(f.running()).toBe(false)
    expect(ios.cancel).toHaveBeenCalledOnce(); expect(f.requests.closeAccount).toHaveBeenCalledOnce()
    expect(f.requests.readResult).not.toHaveBeenCalled(); expect(f.journals.has(A)).toBe(true)
  })
})
