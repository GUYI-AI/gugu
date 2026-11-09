import { describe, expect, it } from 'vitest'
import { installLegacyWebViewShims, structuredCloneFallback } from '../../../../apps/desktop/src/lib/legacy-webview-shims'

describe('legacy WebView shims (Android System WebView 91 has no structuredClone)', () => {
  // A Chrome 91 global: only what that WebView already had.
  function chrome91Global(): typeof globalThis {
    class LegacyArray<T> extends Array<T> {}
    for (const name of ['at', 'findLast', 'findLastIndex', 'toSorted'])
      Object.defineProperty(LegacyArray.prototype, name, { value: undefined, configurable: true, writable: true })
    class LegacyString extends String {}
    Object.defineProperty(LegacyString.prototype, 'at', { value: undefined, configurable: true, writable: true })
    const LegacyObject = Object.assign(Object.create(null), { hasOwn: undefined })
    return { Array: LegacyArray, String: LegacyString, Object: LegacyObject } as unknown as typeof globalThis
  }

  it('fills in structuredClone when the WebView lacks it', () => {
    const target = chrome91Global()
    installLegacyWebViewShims(target)
    const row = { id: 'c1', tags: ['a'], at: new Date(5) }
    const copy = target.structuredClone(row)
    expect(copy).toEqual(row)
    expect(copy).not.toBe(row)
    expect(copy.tags).not.toBe(row.tags)
  })

  it('leaves a native structuredClone alone', () => {
    const native = () => 'native'
    const target = Object.assign(chrome91Global(), { structuredClone: native })
    installLegacyWebViewShims(target)
    expect(target.structuredClone).toBe(native)
  })

  it('matches native structured clone for the types the app stores', () => {
    const shared = { n: 1 }
    const bytes = new Uint8Array([1, 2, 3])
    const value = {
      date: new Date(42), re: /a+/gi, map: new Map([['k', shared]]), set: new Set([shared]),
      bytes, view: new DataView(bytes.buffer, 1, 2), nested: [shared, shared], missing: undefined,
      error: new TypeError('boom'),
    }
    const copy = structuredCloneFallback(value)
    expect(copy).toEqual(structuredClone(value))
    expect(copy.map.get('k')).toBe(copy.nested[0])
    expect(copy.set.has(copy.nested[1]!)).toBe(true)
    expect(copy.bytes).not.toBe(bytes)
    expect(copy.view.buffer).toBe(copy.bytes.buffer)
    expect(copy.error).toBeInstanceOf(TypeError)
    expect(copy.error.message).toBe('boom')
  })

  it('never calls an Error subclass constructor; it comes back as a plain Error like native clone', () => {
    let calls = 0
    class Custom extends Error { constructor(message: string) { super(message); calls++ } }
    const source = new Custom('x')
    calls = 0
    const copy = structuredCloneFallback({ e: source })
    expect(calls).toBe(0)
    expect(Object.getPrototypeOf(copy.e)).toBe(Error.prototype)
    expect(Object.getPrototypeOf(copy.e)).toBe(Object.getPrototypeOf(structuredClone({ e: source }).e))
    expect(copy.e.message).toBe('x')
  })

  it('keeps cycles and drops prototypes like native clone', () => {
    class Box { v = 1; get twice() { return this.v * 2 } }
    const a: { self?: unknown; box: Box } = { box: new Box() }
    a.self = a
    const copy = structuredCloneFallback(a)
    expect(copy.self).toBe(copy)
    expect(Object.getPrototypeOf(copy.box)).toBe(Object.prototype)
    expect(copy.box).toEqual({ v: 1 })
  })

  it('throws DataCloneError for functions like native clone', () => {
    expect(() => structuredCloneFallback({ f: () => 1 })).toThrow(expect.objectContaining({ name: 'DataCloneError' }))
  })

  it('fills in the Chrome 92+ array and object helpers the logged-in screens call', () => {
    const target = chrome91Global()
    installLegacyWebViewShims(target)
    const list = target.Array.from([3, 1, 2]) as number[]
    expect(list.at(-1)).toBe(2)
    expect(list.at(5)).toBeUndefined()
    expect(new target.String('abc').at(-1)).toBe('c')
    expect(list.findLast(n => n > 1)).toBe(2)
    expect(list.findLastIndex(n => n > 5)).toBe(-1)
    expect(list.toSorted((a, b) => a - b)).toEqual([1, 2, 3])
    expect([...list]).toEqual([3, 1, 2])
    expect(target.Object.hasOwn({ a: 1 }, 'a')).toBe(true)
    expect(target.Object.hasOwn(Object.create({ a: 1 }), 'a')).toBe(false)
  })
})
