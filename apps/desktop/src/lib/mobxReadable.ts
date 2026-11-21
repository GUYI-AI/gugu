import { comparer, computed, reaction } from 'mobx'
import { useMemo, type DependencyList } from 'react'
import { useSelect, type Readable } from './selectStore'

/** A MobX derivation as a `Readable` for `useSelect` (@@@client-state-model §6): a `computed` (stable reference) and a reaction on it. */
export function mobxReadable<T>(derive: () => T, equals?: (a: T, b: T) => boolean): Readable<T> {
  // `equals` (e.g. `comparer.structural`): a derivation that builds a new object each time keeps its reference while equal.
  const value = computed(derive, equals ? { equals } : undefined)
  return {
    get: () => value.get(),
    subscribe: (listener) => reaction(() => value.get(), () => listener()),
  }
}

/** A component's MobX derivation (the chats' tab engine), read through `useSelect`; equal by structure. `deps` name what `derive` reads. */
export function useMobxReading<T>(derive: () => T, deps: DependencyList): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` name what `derive` reads
  const readable = useMemo(() => mobxReadable(derive, comparer.structural), deps)
  return useSelect(readable, (value) => value, Object.is)
}
