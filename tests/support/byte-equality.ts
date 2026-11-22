import { expect } from 'vitest'

// toEqual compares typed arrays element by element through its generic deep-equality walk: about 2.4 s per MiB, so a
// test that compares a few downloaded or encrypted payloads spent seconds in the assertion alone. Same constructor,
// same length and the same bytes is the same answer that walk gives; anything else falls through to it unchanged.
expect.addEqualityTesters([
  (actual: unknown, expected: unknown) => {
    if (!ArrayBuffer.isView(actual) || !ArrayBuffer.isView(expected) || actual.constructor !== expected.constructor) return undefined
    if (actual instanceof DataView || !(actual instanceof Uint8Array || actual instanceof Uint8ClampedArray || actual instanceof Int8Array)) return undefined
    const a = actual as Uint8Array, b = expected as Uint8Array
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  },
])
