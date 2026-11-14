import { useRef, useSyncExternalStore } from 'react'

/**
 * @@@select-store - one value that many components read a slice of. A reader names its slice (`select`) and when two
 * slices count as the same (`equals`, shallow by default); it re-renders only when its own slice changes, whatever else
 * in the value moved. The owner publishes during render, so readers rendered in the same pass already see the new
 * value; readers that did not render are told in the owner's layout effect (`notify`).
 */
export type SelectStore<T> = {
  get: () => T
  subscribe: (listener: () => void) => () => void
  /** Render phase: the value readers below this render see. */
  publish: (value: T) => void
  /** Layout phase: tell readers that did not render in this pass. */
  notify: () => void
}

export function createSelectStore<T>(initial: T): SelectStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish: (next) => { value = next },
    notify: () => { for (const listener of [...listeners]) listener() },
  }
}

/** Same own keys, each `Object.is`; anything else `Object.is`. */
export function sameShallow(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  // Only plain objects and arrays compare by their fields; a Map or a Set has none, so two different ones are different.
  if (!plainOrArray(a) || !plainOrArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

function plainOrArray(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return Array.isArray(value) || proto === Object.prototype || proto === null
}

/** What a reader needs of a store: another module's store (one kept on the document, say) can be read the same way. */
export type Readable<T> = Pick<SelectStore<T>, 'get' | 'subscribe'>

export function useSelect<T, S>(store: Readable<T>, select: (value: T) => S, equals: (a: S, b: S) => boolean = sameShallow): S {
  const last = useRef<{ value: S } | null>(null)
  const snapshot = () => {
    const next = select(store.get())
    if (last.current && equals(last.current.value, next)) return last.current.value
    last.current = { value: next }
    return next
  }
  return useSyncExternalStore(store.subscribe, snapshot)
}
