import { describe, expect, it } from 'vitest'
import { completesPhoneBack, GestureVelocity } from '../../../../apps/desktop/src/mobile/gestureVelocity'

describe('phone release intent', () => {
  it('uses recent CSS pixel motion and a release pause instead of average speed since touch down', () => {
    const velocity = new GestureVelocity()
    velocity.add(0, 0, 0); velocity.add(10, 20, 200); velocity.add(40, 80, 240)
    expect(velocity.read()).toEqual({ x: 750, y: 1500 })
    velocity.add(40, 80, 500)
    expect(velocity.read()).toEqual({ x: 0, y: 0 })
  })
  it('requires a real stroke, accepts half-distance or a quick flick, and cancels a strong reversal', () => {
    expect(completesPhoneBack(20, 390, 700)).toBe(true)
    expect(completesPhoneBack(200, 390, 0)).toBe(true)
    expect(completesPhoneBack(120, 390, 0)).toBe(false)
    expect(completesPhoneBack(250, 390, -800)).toBe(false)
    expect(completesPhoneBack(2, 390, 2000)).toBe(false)
  })
})
