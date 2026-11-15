// Android 11 及更早的机器上,没跟着 Play 更新的系统 WebView 可能停在 Chrome 91;`structuredClone` 要到 98 才有。
// 全仓裸用它(本地同步库读行、会话恢复……),缺了就在首屏渲染时 `ReferenceError` → 整个 Web 层只剩错误页。
// 这里按结构化克隆的语义补一个同步实现;同一批 WebView 也缺 `.at` / `Object.hasOwn` / `findLast` / `toSorted`
// (Chrome 92–110),登录后的页面会撞上,一并补上。已有原生实现时什么都不做。import 即生效,必须排在业务模块之前。

function dataCloneError(value: unknown): DOMException {
  return new DOMException(`${String(value)} could not be cloned.`, 'DataCloneError')
}

const STANDARD_ERRORS: Record<string, ErrorConstructor | undefined> = { EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError }

function cloneInto(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') throw dataCloneError(value)
  if (value === null || typeof value !== 'object') return value
  const known = seen.get(value)
  if (known !== undefined) return known
  // Blob / File 本身不可变,原生克隆也只是共享同一份数据。
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof RegExp) return new RegExp(value.source, value.flags)
  if (value instanceof ArrayBuffer) { const copy = value.slice(0); seen.set(value, copy); return copy }
  if (ArrayBuffer.isView(value)) {
    const buffer = cloneInto(value.buffer, seen) as ArrayBuffer
    const copy = value instanceof DataView
      ? new DataView(buffer, value.byteOffset, value.byteLength)
      : new (value.constructor as new (b: ArrayBuffer, o: number, l: number) => ArrayBufferView)(
        buffer, value.byteOffset, (value as unknown as { length: number }).length)
    seen.set(value, copy)
    return copy
  }
  if (value instanceof Map) {
    const copy = new Map()
    seen.set(value, copy)
    for (const [k, v] of value) copy.set(cloneInto(k, seen), cloneInto(v, seen))
    return copy
  }
  if (value instanceof Set) {
    const copy = new Set()
    seen.set(value, copy)
    for (const v of value) copy.add(cloneInto(v, seen))
    return copy
  }
  if (value instanceof Error) {
    // Like native structured clone: only the standard error types survive by name; anything else, a subclass
    // included, comes back as a plain Error. No foreign constructor is ever called.
    const copy = new (STANDARD_ERRORS[value.name] ?? Error)(value.message)
    seen.set(value, copy)
    if (value.stack !== undefined) copy.stack = value.stack
    return copy
  }
  if (typeof Node !== 'undefined' && value instanceof Node) throw dataCloneError(value)
  // 数组与普通对象:只拷自有可枚举字符串键,原型一律变成普通对象 —— 与原生结构化克隆一致。
  const copy: Record<string, unknown> = Array.isArray(value) ? new Array(value.length) as never : {}
  seen.set(value, copy)
  for (const key of Object.keys(value)) copy[key] = cloneInto((value as Record<string, unknown>)[key], seen)
  return copy
}

export function structuredCloneFallback<T>(value: T): T {
  return cloneInto(value, new Map()) as T
}

function define(owner: object, name: string, value: unknown): void {
  if (typeof (owner as Record<string, unknown>)[name] === 'function') return
  Object.defineProperty(owner, name, { value, configurable: true, writable: true })
}

function at(this: { length: number; [index: number]: unknown }, index: number): unknown {
  const n = Math.trunc(index) || 0
  const i = n < 0 ? this.length + n : n
  return i < 0 || i >= this.length ? undefined : this[i]
}

type Predicate = (value: unknown, index: number, array: unknown[]) => unknown

function findLastIndex(this: unknown[], predicate: Predicate, thisArg?: unknown): number {
  for (let i = this.length - 1; i >= 0; i -= 1) if (predicate.call(thisArg, this[i]!, i, this)) return i
  return -1
}

export function installLegacyWebViewShims(target: typeof globalThis = globalThis): void {
  define(target, 'structuredClone', structuredCloneFallback)
  const typedArray = Object.getPrototypeOf(Int8Array.prototype) as object
  for (const proto of [target.Array.prototype, target.String.prototype, typedArray]) define(proto, 'at', at)
  define(target.Object, 'hasOwn', (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key))
  define(target.Array.prototype, 'findLastIndex', findLastIndex)
  define(target.Array.prototype, 'findLast', function (this: unknown[], predicate: Predicate, thisArg?: unknown) {
    const i = findLastIndex.call(this, predicate, thisArg)
    return i < 0 ? undefined : this[i]
  })
  define(target.Array.prototype, 'toSorted', function (this: unknown[], compare?: (a: unknown, b: unknown) => number) {
    return Array.prototype.slice.call(this).sort(compare)
  })
}

installLegacyWebViewShims()
