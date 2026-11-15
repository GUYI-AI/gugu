import { computed, reaction } from 'mobx'
import type { Readable } from './selectStore'

/**
 * A MobX derivation as a `Readable` for `useSelect` (@@@client-state-model §6, the MobX adapter): `get` is a `computed`
 * (cached while subscribed, so the same value comes back as the same reference), `subscribe` a reaction on it. Lives
 * until PR 5 removes the last MobX store. Keep the derivation's result small (a primitive, or what `useSelect`'s
 * `equals` can compare), or pass `equals`.
 */
export function mobxReadable<T>(derive: () => T, equals?: (a: T, b: T) => boolean): Readable<T> {
  // `equals` (e.g. `comparer.structural`): a derivation that builds a new object each time keeps its reference while equal.
  const value = computed(derive, equals ? { equals } : undefined)
  return {
    get: () => value.get(),
    subscribe: (listener) => reaction(() => value.get(), () => listener()),
  }
}
