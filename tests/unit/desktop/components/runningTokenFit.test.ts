import { describe, expect, it } from 'vitest'
import { settleRunningTokenFit } from '../../../../apps/desktop/src/components/runningTokenFit'

describe('running strip fitting with proportional overflow digits', () => {
  const widths = [144, 134, ...Array<number>(10).fill(168)]
  const required = (visible: number, counter: number) => widths.slice(0, visible).reduce((sum, width) => sum + width + 8, counter)

  it('measures the 328px +11/+10 boundary at most once per candidate and settles consistently', () => {
    for (let pass = 0; pass < 3; pass++) {
      const measured: number[] = []
      const result = settleRunningTokenFit(2, (visible) => {
        measured.push(visible)
        expect(measured.length).toBeLessThanOrEqual(2)
        const counter = visible === 1 ? 32 : 35
        return required(2, counter) <= 328 ? 2 : 1
      })
      expect(result).toBe(1)
      expect(measured).toEqual([2, 1])
      expect(required(result, 32)).toBeLessThanOrEqual(328)
      expect(required(result + 1, 35)).toBeGreaterThan(328)
    }
  })

  it('tries intermediate prefixes instead of skipping a valid narrower counter', () => {
    const measured: number[] = []
    expect(settleRunningTokenFit(5, (visible) => {
      measured.push(visible)
      return visible === 5 ? 3 : 4
    })).toBe(4)
    expect(measured).toEqual([5, 4])
  })

  it('can show more again on the next wider viewport', () => {
    const measured: number[] = []
    expect(settleRunningTokenFit(3, (visible) => {
      measured.push(visible)
      return required(3, 30) <= 500 ? 3 : 2
    })).toBe(3)
    expect(measured).toEqual([3])
  })

  it('preserves the one-token minimum when the viewport is hidden', () => {
    let measurements = 0
    expect(settleRunningTokenFit(1, () => { measurements++; return 0 })).toBe(1)
    expect(measurements).toBe(1)
  })

  it('does not measure an empty strip', () => {
    let measurements = 0
    expect(settleRunningTokenFit(0, () => { measurements++; return 0 })).toBe(0)
    expect(measurements).toBe(0)
  })
})
