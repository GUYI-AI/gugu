import { useRef, useSyncExternalStore } from 'react'
import { onAccountChange } from './replica'

/**
 * @@@select-store - one value that many components read a slice of. A reader names its slice (`select`) and when two
 * slices count as the same (`equals`, shallow by default); it re-renders only when its own slice changes, whatever else
 * in the value moved. The owner publishes during render, so readers rendered in the same pass already see the new
 * value; readers that did not render are told in the owner's layout effect (`notify`).
 * @@@client-state-model — the one subscription primitive (docs/design/client-state-model.md §6).
 */
export type SelectStore<T> = {
  get: () => T
  subscribe: (listener: () => void) => () => void
  /** Render phase: the value readers below this render see. */
  publish: (value: T) => void
  /** Layout phase: tell readers that did not render in this pass. */
  notify: () => void
  /** Outside render (an event, an answer): publish and tell at once. */
  set: (value: T) => void
}

/**
 * `scope: 'account'`: the value belongs to the signed-in person — back to `initial` when another person signs in or the
 * account signs out, as the replica judges it (`onAccountChange`). ❌ A store following the session by hand.
 */
export function createSelectStore<T>(initial: T, options: { scope?: 'account' } = {}): SelectStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  const store: SelectStore<T> = {
    get: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish: (next) => { value = next },
    notify: () => { for (const listener of [...listeners]) listener() },
    set: (next) => { value = next; store.notify() },
  }
  if (options.scope === 'account') onAccountChange(() => { if (value !== initial) { value = initial; store.notify() } })
  return store
}

/** One key of a record or Map store, set or (`undefined`) removed, and its readers told: ❌ the spread / rest by hand at each caller. */
export function patch<T extends Record<string, unknown>>(store: SelectStore<T>, key: string, next: T[string] | undefined): void
export function patch<K, V>(store: SelectStore<ReadonlyMap<K, V>>, key: K, next: V | undefined): void
export function patch<T>(store: SelectStore<T>, key: unknown, next: unknown): void {
  const now: unknown = store.get()
  if (now instanceof Map) {
    if (next === undefined ? !now.has(key) : Object.is(now.get(key), next)) return
    const copy = new Map(now)
    if (next === undefined) copy.delete(key)
    else copy.set(key, next)
    store.set(copy as T)
    return
  }
  const record = now as Record<string, unknown>
  const name = key as string
  if (next === undefined ? !(name in record) : Object.is(record[name], next)) return
  if (next === undefined) {
    const { [name]: _removed, ...rest } = record
    store.set(rest as T)
  } else store.set({ ...record, [name]: next } as T)
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
