import { expect, it } from 'vitest'
import { excerpt, matchRanges } from './search'

it('highlights original text after lowercase expansion', () => {
  const text = 'İstanbul docs'
  const ranges = matchRanges(text, 'docs')
  expect(ranges).toEqual([{ start: 9, end: 13 }])
  expect(text.slice(ranges[0].start, ranges[0].end)).toBe('docs')
  expect(matchRanges('İx', 'i')).toEqual([{ start: 0, end: 1 }])
  expect(matchRanges('ΟΣ', 'ος')).toEqual([{ start: 0, end: 2 }])
  expect(matchRanges('a𐐀b', '𐐨')).toEqual([{ start: 1, end: 3 }])
})

it('keeps search excerpts on original Unicode boundaries', () => {
  const before = 'İ'.repeat(80) + '😀'.repeat(30)
  const text = before + 'needle ' + 'z'.repeat(150)
  expect(excerpt(text, 'needle')).toContain('needle')
  const cut = excerpt('a'.repeat(119) + '😀tail', 'a')
  expect(cut).toBe('a'.repeat(119) + '…')
  const shifted = excerpt(
    'a'.repeat(31) + '😀' + 'b'.repeat(29) + 'needle' + 'z'.repeat(150),
    'needle'
  )
  expect(shifted).not.toMatch(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  )
})

it('moves an excerpt start inside a surrogate pair inward without exceeding the budget', () => {
  const text = 'prefix😀' + 'a'.repeat(29) + 'needle' + 'b'.repeat(140)
  expect(excerpt(text, 'needle')).toBe('…' + 'a'.repeat(29) + 'needle' + 'b'.repeat(84) + '…')
})
