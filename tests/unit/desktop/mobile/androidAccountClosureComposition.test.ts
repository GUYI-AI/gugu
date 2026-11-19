import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeAndroidAccountClosure } from '../../../../apps/desktop/src/mobile/android-runtime/androidAccountClosureComposition'
import type { AccountClosureNative, AccountClosureScope } from '../../../../apps/desktop/src/platform/accountClosure'
import type { AccountClosureJournal } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureLocalCleanup'
import type { PhoneCloseAcknowledgement } from '../../../../apps/desktop/src/components/settings/accountDeletion/phoneAccountClosureFlow'

function setup(result: PhoneCloseAcknowledgement = { status: 'failed' }) {
  const events: string[] = [], receipts = new Map<string, string>()
  let scope: AccountClosureScope | null = null, owner = 'A', enabled = true, sealed = false
  const native: AccountClosureNative = {
    receipt: {
      put: vi.fn(async (value, receipt) => { events.push('put'); receipts.set(value.localOperationId, receipt) }),
      get: vi.fn(async value => receipts.get(value.localOperationId) ?? null),
      remove: vi.fn(async value => { events.push('remove'); receipts.delete(value.localOperationId) }),
    },
    eraseLocal: vi.fn(async () => { events.push('erase'); return { status: 'complete' as const, retainedUnattributed: [] } }),
  }
  const journal: AccountClosureJournal = {
    write: vi.fn(async value => { scope = value }), read: vi.fn(async () => scope),
    remove: vi.fn(async () => { events.push('journal-remove'); scope = null }),
  }
  const preparation = {
    prepare: vi.fn(async () => { events.push('prepare'); sealed = true; return { deviceId: 'phone-install-A' } }),
    retire: vi.fn(async () => { events.push('retire') }),
    cancel: vi.fn(async () => { events.push('cancel'); sealed = false }),
  }
  const stopPublication = vi.fn(async () => { events.push('stop-publication'); enabled = false })
  const removeRegistration = vi.fn(async () => { events.push('remove-registration') })
  const requests = {
    closeAccount: vi.fn(async (input: { captureReceipt: (receipt: string) => Promise<void> }) => {
      events.push('close'); await input.captureReceipt('opaque-fixture-receipt'); return result
    }),
    readResult: vi.fn(async () => { events.push('read'); return result }),
  }
  return { events, native, journal, preparation, stopPublication, removeRegistration, requests,
    enabled: () => enabled, sealed: () => sealed, saved: () => scope,
    switchOwner: (value: string) => { owner = value },
    create: () => composeAndroidAccountClosure({ ownerId: 'A', requests, journal }, { native, preparation, currentOwnerId: () => owner, stopPublication, removeRegistration }),
  }
}
afterEach(() => vi.useRealTimers())

describe('Android closure preparation finalization', () => {
  it.each(['failed', 'expired'] as const)('%s removes the receipt before explicit cancellation without restarting an agent', async status => {
    const f = setup({ status }); const flow = await f.create(); await flow.start()
    expect(f.events).toEqual(['prepare', 'stop-publication', 'remove-registration', 'retire', 'close', 'put', 'remove', 'cancel', 'journal-remove'])
    expect(f.native.eraseLocal).not.toHaveBeenCalled()
    expect(f.enabled()).toBe(false); expect(f.sealed()).toBe(false)
    expect(flow.getSnapshot()).toEqual({ status: 'failed', phase: 'close-account', canRetry: false })
  })
  it('keeps preparation and receipt for an unknown server result', async () => {
    const f = setup({ status: 'processing' }); const flow = await f.create(); await flow.start()
    expect(flow.getSnapshot().status).toBe('unconfirmed'); expect(f.sealed()).toBe(true)
    expect(f.native.receipt.remove).not.toHaveBeenCalled(); expect(f.preparation.cancel).not.toHaveBeenCalled()
  })
  it('keeps preparation throughout the five pending erase attempts', async () => {
    vi.useFakeTimers(); const f = setup({ status: 'deleted' })
    vi.mocked(f.native.eraseLocal).mockResolvedValue({ status: 'pending', retainedUnattributed: [] })
    const flow = await f.create(); const work = flow.start(); await vi.runAllTimersAsync(); await work
    expect(flow.getSnapshot().status).toBe('local-pending'); expect(f.native.eraseLocal).toHaveBeenCalledTimes(5)
    expect(f.sealed()).toBe(true); expect(f.enabled()).toBe(false)
    expect(f.native.receipt.remove).not.toHaveBeenCalled(); expect(f.preparation.cancel).not.toHaveBeenCalled()
  })
  it('retains the seal after deleted completion and explicit receipt removal', async () => {
    const f = setup({ status: 'deleted' }); const flow = await f.create(); await flow.start()
    expect(flow.getSnapshot().status).toBe('closed'); expect(f.native.eraseLocal).toHaveBeenCalledOnce()
    expect(f.native.receipt.remove).toHaveBeenCalledOnce(); expect(f.preparation.cancel).not.toHaveBeenCalled()
    expect(f.sealed()).toBe(true); expect(f.enabled()).toBe(false)
  })
  it.each(['failed', 'expired'] as const)('%s cancellation failure rejects and retains custody instead of reporting success', async status => {
    const f = setup({ status }); const failure = Object.assign(new Error('Preparation cancellation failed'), { code: 'closure_storage_unavailable' })
    f.preparation.cancel.mockImplementation(async () => { throw failure })
    const flow = await f.create(); await expect(flow.start()).rejects.toBe(failure)
    expect(flow.getSnapshot().status).toBe('failed'); expect(f.enabled()).toBe(false); expect(f.sealed()).toBe(true)
    expect(f.native.receipt.remove).toHaveBeenCalledOnce(); expect(f.journal.remove).not.toHaveBeenCalled(); expect(f.saved()).not.toBeNull()
  })
  it('unavailable retry actions preserve a cancellation failure instead of reporting completion', async () => {
    const f = setup(); const failure = new Error('Protected write failure')
    f.preparation.cancel.mockRejectedValueOnce(failure)
    const flow = await f.create(); await expect(flow.start()).rejects.toBe(failure)
    await expect(flow.retryLocal()).rejects.toBe(failure)
    await expect(flow.retry()).rejects.toBe(failure)
    expect(f.preparation.cancel).toHaveBeenCalledOnce()
    expect(f.sealed()).toBe(true); expect(f.enabled()).toBe(false)
    expect(f.saved()).not.toBeNull(); expect(f.native.eraseLocal).not.toHaveBeenCalled()
  })
  it('a cancellation rejection without a payload still fails instead of completing', async () => {
    const f = setup(); f.preparation.cancel.mockRejectedValueOnce(undefined)
    const flow = await f.create(); await expect(flow.start()).rejects.toMatchObject({ code: 'closure_storage_unavailable' })
    expect(f.sealed()).toBe(true); expect(f.enabled()).toBe(false); expect(f.saved()).not.toBeNull()
  })
  it('never submits closure after stop or device retirement fails', async () => {
    const f = setup(); f.removeRegistration.mockRejectedValue(new Error('Device removal failed'))
    const flow = await f.create(); await flow.start()
    expect(flow.getSnapshot()).toEqual({ status: 'failed', phase: 'remove-device', canRetry: false })
    expect(f.preparation.retire).not.toHaveBeenCalled(); expect(f.requests.closeAccount).not.toHaveBeenCalled()
  })
  it('refuses another current account before touching its runtime or registration', async () => {
    const f = setup(); f.switchOwner('B'); await expect(f.create()).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(f.events).toEqual([]); expect(f.enabled()).toBe(true)
  })
  it('restores an unknown submission by reading the same saved operation, never resubmitting or repeating cleanup', async () => {
    const f = setup({ status: 'processing' }); const first = await f.create(); await first.start()
    const saved = f.saved(); f.events.length = 0; const restored = await f.create()
    expect(f.events).toEqual(['read']); expect(f.saved()).toEqual(saved); expect(restored.getSnapshot().status).toBe('unconfirmed')
    expect(f.preparation.prepare).toHaveBeenCalledOnce(); expect(f.removeRegistration).toHaveBeenCalledOnce(); expect(f.requests.closeAccount).toHaveBeenCalledOnce()
  })
})
