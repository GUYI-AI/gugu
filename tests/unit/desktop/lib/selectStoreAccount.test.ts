import { beforeEach, expect, it, vi } from 'vitest'

/**
 * A store of the signed-in person (`createSelectStore(initial, { scope: 'account' })`): back to `initial` when another
 * person signs in or the account signs out, judged as the replica judges it (`onAccountChange`). What every
 * account-scoped store relies on (wake refusals, package progress, …), tested once here instead of per store.
 */
type Replica = typeof import('../../../../apps/desktop/src/lib/replica')
type Stores = typeof import('../../../../apps/desktop/src/lib/selectStore')
let replica: Replica, stores: Stores
beforeEach(async () => {
  vi.resetModules()
  replica = await import('../../../../apps/desktop/src/lib/replica')
  stores = await import('../../../../apps/desktop/src/lib/selectStore')
  replica.followRendererSession('SIGNED_IN', 'alice')
})

it('another person signing in, or a sign-out, puts the store back to its initial value and tells its readers', () => {
  const store = stores.createSelectStore<Record<string, number>>({}, { scope: 'account' })
  const heard = vi.fn()
  store.subscribe(heard)
  stores.patch(store, 'a', 1)
  expect(store.get()).toEqual({ a: 1 })
  replica.followRendererSession('SIGNED_IN', 'bob')
  expect(store.get()).toEqual({})
  expect(heard).toHaveBeenCalledTimes(2)
  stores.patch(store, 'b', 2)
  replica.followRendererSession('SIGNED_OUT', null)
  expect(store.get()).toEqual({})
})

it('the same person again, or a session merely absent, keeps it; patch with undefined removes one key', () => {
  const store = stores.createSelectStore<Record<string, number>>({}, { scope: 'account' })
  stores.patch(store, 'a', 1)
  stores.patch(store, 'b', 2)
  replica.followRendererSession('TOKEN_REFRESHED', 'alice')
  expect(store.get()).toEqual({ a: 1, b: 2 })
  stores.patch(store, 'a', undefined)
  expect(store.get()).toEqual({ b: 2 })
})
