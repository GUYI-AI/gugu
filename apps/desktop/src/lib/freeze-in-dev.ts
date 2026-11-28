/**
 * In development builds (and tests), freeze plain objects and arrays all the way down, so a write into a value that
 * others keep by identity throws where it happens. Production returns the value untouched.
 *
 * For values whose readers cache on identity: a cached replica value (`useReplica` keeps a reading while its value is
 * the same object) and the timeline's turns (a tick redraws only for a new turn object). Changing such a value in
 * place would leave every reader showing the old one; the contract is "a change is a new object", and this checks it.
 * Only plain objects and arrays are frozen: class instances, Maps, Dates and typed arrays are left as they are.
 */
export function freezeInDev<T>(value: T): T {
  if (import.meta.env.DEV) freezeDeep(value)
  return value
}

function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return
  Object.freeze(value)
  // Every own key, symbols and non-enumerable ones included; a getter is not called.
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (property && 'value' in property) freezeDeep(property.value)
  }
}
