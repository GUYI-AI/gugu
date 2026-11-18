import { describe, expect, it } from 'vitest'
import { railAppVisibleCount } from '../../../../apps/desktop/src/components/sidebar/railAppCapacity'

describe('pinned Apps fit after the fixed rail entries', () => {
  it('keeps all Apps and needs no More entry when they fit exactly', () => {
    expect(railAppVisibleCount(4, 184, 40, 8)).toBe(4)
    expect(railAppVisibleCount(4, 500, 40, 8)).toBe(4)
  })
  it('reserves a whole More entry when even one App exceeds the available height', () => {
    expect(railAppVisibleCount(5, 184, 40, 8)).toBe(3)
    expect(railAppVisibleCount(40, 184, 40, 8)).toBe(3)
  })
  it('shows only More when only one row fits, including an incomplete first measurement', () => {
    expect(railAppVisibleCount(20, 40, 40, 8)).toBe(0)
    expect(railAppVisibleCount(20, 0, 40, 8)).toBe(0)
    expect(railAppVisibleCount(20, 300, 0, 8)).toBe(0)
  })
  it('moves Apps back and forth as footer height or available window space changes', () => {
    expect([280, 232, 376, 280].map(height => railAppVisibleCount(8, height, 40, 8))).toEqual([5, 4, 8, 5])
  })
  it('uses measured row height and gap rather than assuming one density', () => {
    expect(railAppVisibleCount(6, 200, 44, 8)).toBe(3)
    expect(railAppVisibleCount(6, 200, 32, 4)).toBe(4)
    expect(railAppVisibleCount(4, 181.5, 39.75, 7.5)).toBe(4)
    expect(railAppVisibleCount(4, 181.49, 39.75, 7.5)).toBe(2)
  })
  it('does not introduce a More entry for an empty list', () => {
    expect(railAppVisibleCount(0, 0, 0, 0)).toBe(0)
  })
})
