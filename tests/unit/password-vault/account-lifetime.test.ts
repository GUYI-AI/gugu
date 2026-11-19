import { describe, expect, it, vi } from 'vitest'
import { PasswordAccountLifetime } from '../../../apps/desktop/electron/password-vault/account-lifetime'

interface Account { ownerId: string }
function fixture() {
  let owner: string | null = 'A'
  const pending = new Map(['A', 'B'].map(id => [id, Promise.withResolvers<Account>()]))
  const entered = new Map(['A', 'B'].map(id => [id, Promise.withResolvers<void>()]))
  const dispose = vi.fn(async (_value: Account) => {})
  const lifetime = new PasswordAccountLifetime<Account>({ currentOwner: async () => owner,
    create: id => { entered.get(id)!.resolve(); return pending.get(id)!.promise }, dispose,
    unavailable: () => new Error('unavailable'),
  })
  return { lifetime, dispose, pending, entered, owner: (id: string | null) => { owner = id } }
}
describe('password vault native account lifetime', () => {
  it('never serves an in-flight A construction to B after an account switch', async () => {
    const f = fixture(), a = f.lifetime.get()
    const rejectedA = expect(a).rejects.toThrow('unavailable')
    await f.entered.get('A')!.promise
    f.owner('B')
    const b = f.lifetime.get(); await f.entered.get('B')!.promise
    f.pending.get('A')!.resolve({ ownerId: 'A' }); await rejectedA
    const value = { ownerId: 'B' }; f.pending.get('B')!.resolve(value)
    expect(await b).toBe(value)
    expect(f.dispose).toHaveBeenCalledExactlyOnceWith({ ownerId: 'A' })
    expect(f.lifetime.current).toBe(value)
  })
  it('closure waits for an unpublished A and its disposal while allowing B to finish independently', async () => {
    const f = fixture(), a = f.lifetime.get(), disposal = Promise.withResolvers<void>()
    const rejectedA = expect(a).rejects.toThrow('unavailable')
    await f.entered.get('A')!.promise
    f.dispose.mockImplementation(async value => { if (value.ownerId === 'A') await disposal.promise })
    let closed = false
    const closing = f.lifetime.close('A').then(() => { closed = true })
    f.owner('B'); const b = f.lifetime.get(); await f.entered.get('B')!.promise
    const value = { ownerId: 'B' }; f.pending.get('B')!.resolve(value)
    expect(await b).toBe(value); expect(closed).toBe(false)
    f.pending.get('A')!.resolve({ ownerId: 'A' })
    await Promise.resolve(); expect(closed).toBe(false)
    disposal.resolve(); await closing; await rejectedA
    expect(f.dispose).toHaveBeenCalledExactlyOnceWith({ ownerId: 'A' })
    expect(f.lifetime.current).toBe(value)
  })
  it('does not swallow a failed disposal or forget the A account before a successful retry', async () => {
    const f = fixture(), value = { ownerId: 'A' }
    f.pending.get('A')!.resolve(value); await f.lifetime.get()
    f.dispose.mockRejectedValueOnce(new Error('write still unconfirmed'))
    await expect(f.lifetime.close('A')).rejects.toThrow('write still unconfirmed')
    expect(f.lifetime.current).toBe(value)
    await f.lifetime.close('A')
    expect(f.lifetime.current).toBeUndefined()
    await expect(f.lifetime.get()).rejects.toThrow('unavailable')
    expect(f.dispose).toHaveBeenCalledTimes(2)
  })
  it('revokes admission and waits for an already-running sync write before disposing the account', async () => {
    const entered = Promise.withResolvers<void>(), write = Promise.withResolvers<void>()
    const events: string[] = [], value = { ownerId: 'A' }
    const lifetime = new PasswordAccountLifetime<Account>({ currentOwner: async () => 'A', create: async () => value,
      invalidate: () => { events.push('revoke') }, dispose: async () => { events.push('dispose') }, unavailable: () => new Error('unavailable') })
    await lifetime.get()
    const operation = lifetime.run(value, async () => { entered.resolve(); await write.promise; events.push('write-finished') })
    await entered.promise
    const closing = lifetime.close('A')
    expect(events).toEqual(['revoke'])
    await expect(lifetime.run(value, async () => {})).rejects.toThrow('unavailable')
    write.resolve(); await operation; await closing
    expect(events).toEqual(['revoke', 'write-finished', 'dispose'])
  })
})
