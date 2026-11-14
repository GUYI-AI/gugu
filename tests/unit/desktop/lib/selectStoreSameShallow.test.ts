// sameShallow compares plain objects and arrays by their fields. A Map or a Set has no own fields, so two different ones
// must not count as the same selection (a reader picking one would otherwise never see it change).
import { expect, it } from 'vitest'
import { sameShallow } from '@/lib/selectStore'

it('plain objects and arrays compare by field; different Maps and Sets are different', () => {
  const row = { id: 'm1' }
  expect(sameShallow({ a: 1, row }, { a: 1, row })).toBe(true)
  expect(sameShallow([1, row], [1, row])).toBe(true)
  expect(sameShallow({ a: 1 }, { a: 2 })).toBe(false)
  expect(sameShallow(new Map([['a', 1]]), new Map([['a', 2]]))).toBe(false)
  expect(sameShallow(new Set([1]), new Set([2]))).toBe(false)
  const same = new Map()
  expect(sameShallow(same, same)).toBe(true)
})
