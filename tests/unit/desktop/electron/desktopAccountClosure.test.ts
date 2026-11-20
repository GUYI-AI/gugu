import { describe, expect, it, vi } from 'vitest'
import { createDesktopClosureService } from '../../../../apps/desktop/electron/account-closure/service'
import { createHumanAuthSessionIpc } from '../../../../apps/desktop/electron/runtime-auth-provider'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const scope = { ownerId: A, localOperationId: 'opaque-operation/one' }
function fixture() {
  const values = new Map<string, string>()
  let owner: string | null | undefined = A
  let failWrite = false
  let finish = false
  const calls: string[] = []
  const stop = vi.fn(async (_owner: string) => {})
  const restart = () => createDesktopClosureService({
    profileBinding: '/isolated/native-profile', currentOwner: async () => owner,
    secrets: { getSecret: async key => values.get(key) ?? null, setSecret: async (key, value) => {
      if (failWrite) throw new Error('private underlying storage error')
      values.set(key, value)
    } }, stopOwner: stop,
    steps: [
      { name: 'account-cache', run: async () => { calls.push('cache'); return true } },
      { name: 'account-identity', run: async () => { calls.push('identity'); return finish } },
    ], retained: async () => ['workspace-files', 'unattributed-history'],
  })
  const service = restart()
  return { service, restart, values, calls, stop, owner: (value: typeof owner) => { owner = value },
    failWrite: (value: boolean) => { failWrite = value }, finish: () => { finish = true } }
}
describe('desktop native account closure custody', () => {
  it('requires a native capture for get/remove/erase and never creates one on reads or admission', async () => {
    const f = fixture()
    for (const action of [() => f.service.native.receipt.get(scope), () => f.service.native.receipt.remove(scope), () => f.service.native.eraseLocal(scope)]) {
      await expect(action()).rejects.toMatchObject({ code: 'closure_context_missing' })
    }
    expect(await f.service.isPaused(A)).toBe(false)
    expect(f.values.size).toBe(0)
    expect(f.calls).toEqual([])
  })
  it('captures an opaque non-UUID operation id, is idempotent and rejects a conflicting receipt', async () => {
    const f = fixture()
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    const original = [...f.values]
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    expect([...f.values]).toEqual(original)
    await expect(f.service.native.receipt.put(scope, 'other')).rejects.toMatchObject({ code: 'scope_conflict' })
    expect(await f.service.native.receipt.get(scope)).toBe('opaque-receipt')
  })
  it.each([B, undefined])('does not substitute an owner parameter for native owner %s', async owner => {
    const f = fixture()
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    f.owner(owner)
    for (const action of [() => f.service.native.receipt.get(scope), () => f.service.native.receipt.remove(scope), () => f.service.native.eraseLocal(scope)]) {
      await expect(action()).rejects.toMatchObject({ code: owner === B ? 'wrong_local_owner' : 'closure_storage_unavailable' })
    }
    expect(f.calls).toEqual([])
  })
  it('keeps the receipt and checkpoint while pending, resumes after restart and explicitly removes only on completion', async () => {
    const f = fixture()
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    await expect(f.service.native.eraseLocal(scope)).rejects.toMatchObject({ code: 'closure_not_prepared' })
    await f.service.prepare(scope)
    expect(await f.service.native.eraseLocal(scope)).toMatchObject({ status: 'pending' })
    expect(await f.service.native.receipt.get(scope)).toBe('opaque-receipt')
    f.finish()
    const resumed = f.restart()
    expect(await resumed.native.eraseLocal(scope)).toEqual({ status: 'complete', retainedUnattributed: ['unattributed-history', 'workspace-files'] })
    expect(f.calls).toEqual(['cache', 'identity', 'identity'])
    f.owner(null)
    expect((await resumed.native.eraseLocal(scope)).status).toBe('complete')
    expect(f.calls).toHaveLength(3)
    await resumed.native.receipt.remove(scope)
    expect(await resumed.native.receipt.get(scope)).toBeNull()
  })
  it('after failed or expired removes the seal only after receipt removal and deliberately stays paused', async () => {
    const f = fixture()
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    await f.service.prepare(scope)
    await expect(f.service.cancel(scope)).rejects.toMatchObject({ code: 'scope_conflict' })
    await f.service.native.receipt.remove(scope)
    expect(await f.service.cancel(scope)).toEqual({ cancelled: true })
    expect(await f.service.isSealed(A)).toBe(false)
    expect(await f.service.isPaused(A)).toBe(true)
    expect(f.calls).toEqual([])
  })
  it('an old removed operation cannot cancel a newer preparation or erase on its behalf', async () => {
    const f = fixture(), next = { ...scope, localOperationId: 'next-opaque-operation' }
    await f.service.native.receipt.put(scope, 'old-receipt'); await f.service.prepare(scope)
    await f.service.native.receipt.remove(scope); await f.service.cancel(scope)
    await f.service.native.receipt.put(next, 'new-receipt'); await f.service.prepare(next)
    await expect(f.service.cancel(scope)).rejects.toMatchObject({ code: 'scope_conflict' })
    await expect(f.service.native.eraseLocal(scope)).rejects.toMatchObject({ code: 'receipt_missing' })
    expect(await f.service.isSealed(A)).toBe(true)
    expect(await f.service.native.receipt.get(next)).toBe('new-receipt')
    expect(f.calls).toEqual([])
  })
  it('never unseals or accepts a renewed auth mirror after destructive cleanup began', async () => {
    const f = fixture()
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    await f.service.prepare(scope)
    await f.service.native.eraseLocal(scope)
    await f.service.native.receipt.remove(scope)
    await expect(f.service.cancel(scope)).rejects.toMatchObject({ code: 'scope_conflict' })
    await expect(f.service.requireAuthWrite(A)).rejects.toMatchObject({ code: 'closure_not_prepared' })
    await expect(f.service.requireAuthWrite(B)).resolves.toBeUndefined()
  })
  it('the actual auth IPC mutation refuses late A credentials after erase began and still accepts a B login', async () => {
    const f = fixture()
    await f.service.native.receipt.put(scope, 'opaque-receipt'); await f.service.prepare(scope); await f.service.native.eraseLocal(scope)
    const set = vi.fn(), persist = vi.fn(async (_mirror: { access_token: string }) => {})
    const ipc = createHumanAuthSessionIpc({ toAuth: input => ({ userId: input.accessToken, accessToken: 'fixture' }), set,
      persist, erase: async () => {}, revoke: () => {}, leaveIfChanging: async () => {}, enter: async () => {}, changed: () => {},
      mutate: (owner, operation) => f.service.underAuth(async () => { if (owner) await f.service.requireAuthWrite(owner); return operation() }),
    })
    await expect(ipc.write({ access_token: A })).rejects.toMatchObject({ code: 'closure_not_prepared' })
    expect(set).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled()
    await ipc.write({ access_token: B })
    expect(persist).toHaveBeenCalledExactlyOnceWith({ access_token: B })
    expect(set).toHaveBeenLastCalledWith({ userId: B, accessToken: 'fixture' })
  })
  it('a failed runtime stop never acknowledges preparation or runs cleanup and keeps the receipt', async () => {
    const f = fixture()
    f.stop.mockRejectedValue(new Error('process exit unconfirmed'))
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    await expect(f.service.prepare(scope)).rejects.toMatchObject({ code: 'closure_not_prepared' })
    expect(await f.service.native.eraseLocal(scope)).toMatchObject({ status: 'pending' })
    expect(await f.service.native.receipt.get(scope)).toBe('opaque-receipt')
    expect(f.calls).toEqual([])
  })
  it('does not hold the auth barrier while waiting for runtime exits and refuses a late A acknowledgement after B signed in', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    f.stop.mockImplementation(async () => { entered.resolve(); await gate.promise })
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    const preparing = f.service.prepare(scope)
    await entered.promise
    await f.service.underAuth(async () => { f.owner(B) })
    gate.resolve()
    await expect(preparing).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(A)
    expect(await f.service.isPaused(A)).toBe(true)
    expect(await f.service.isPaused(B)).toBe(false)
    expect(f.calls).toEqual([])
  })
  it('fails before the first destructive action if persisting the erase fence fails', async () => {
    const f = fixture()
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    await f.service.prepare(scope)
    f.failWrite(true)
    await expect(f.service.native.eraseLocal(scope)).rejects.toMatchObject({ code: 'closure_storage_unavailable' })
    expect(f.calls).toEqual([])
    f.failWrite(false)
    expect(await f.service.native.receipt.get(scope)).toBe('opaque-receipt')
  })
  it('does not turn corruption into an absent receipt or a successful empty erase', async () => {
    const f = fixture()
    await f.service.native.receipt.put(scope, 'opaque-receipt')
    const key = [...f.values.keys()].find(key => key.startsWith('account-closure:'))!
    f.values.set(key, '{damaged')
    await expect(f.service.native.receipt.get(scope)).rejects.toMatchObject({ code: 'closure_storage_unavailable' })
    await expect(f.service.native.eraseLocal(scope)).rejects.toMatchObject({ code: 'closure_storage_unavailable' })
    expect(f.calls).toEqual([])
  })
})
