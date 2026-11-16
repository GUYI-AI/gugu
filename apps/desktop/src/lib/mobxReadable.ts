import { computed, reaction } from 'mobx'
import type { Readable } from './selectStore'

/** A MobX derivation as a `Readable` for `useSelect` (@@@client-state-model §6): a `computed` (stable reference) and a reaction on it. */
export function mobxReadable<T>(derive: () => T, equals?: (a: T, b: T) => boolean): Readable<T> {
  // `equals` (e.g. `comparer.structural`): a derivation that builds a new object each time keeps its reference while equal.
  const value = computed(derive, equals ? { equals } : undefined)
  return {
    get: () => value.get(),
    subscribe: (listener) => reaction(() => value.get(), () => listener()),
  }
}
