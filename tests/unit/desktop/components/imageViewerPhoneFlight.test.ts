// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { CLOSE_SPRING, containBox, dragBackdrop, dragRadius, dragScale, OPEN_SPRING, shouldCloseOnRelease, SPRING_BACK, springCurve, thumbRadius, usesPhoneFlight } from '../../../../apps/desktop/src/components/preview/image-viewer-phone-flight'

describe('phone image flight (#3311)', () => {
  it('shrinks with the downward drag only, to 0.7 at half the screen', () => {
    expect(dragScale(0, 800)).toBe(1)
    expect(dragScale(-200, 800)).toBe(1)
    expect(dragScale(400, 800)).toBeCloseTo(0.7)
    expect(dragScale(2000, 800)).toBeCloseTo(0.4)
  })

  it('fades the backdrop either way', () => {
    expect(dragBackdrop(0, 800)).toBe(1)
    expect(dragBackdrop(-160, 800)).toBeCloseTo(dragBackdrop(160, 800))
    expect(dragBackdrop(1000, 800)).toBeCloseTo(0.15)
  })

  it('closes past a fifth of the screen or on a downward flick faster than 500 px/s', () => {
    expect(shouldCloseOnRelease(170, 0, 800)).toBe(true)
    expect(shouldCloseOnRelease(150, 0, 800)).toBe(false)
    expect(shouldCloseOnRelease(60, 650, 800)).toBe(true)
    expect(shouldCloseOnRelease(60, 450, 800)).toBe(false)
    expect(shouldCloseOnRelease(-200, 900, 800), 'dragged up never closes').toBe(false)
  })

  it('fits a picture into an area by its aspect ratio, centred', () => {
    expect(containBox(0.5, { x: 0, y: 0, width: 400, height: 400 })).toEqual({ x: 100, y: 0, width: 200, height: 400 })
    expect(containBox(2, { x: 0, y: 0, width: 400, height: 400 })).toEqual({ x: 0, y: 100, width: 400, height: 200 })
  })

  it('reads the corner from the image, or from a bubble only when it actually clips the image', () => {
    const bubble = document.body.appendChild(document.createElement('div'))
    // jsdom 不展开 border-radius / overflow 简写,这里写长名;真浏览器里的简写与「气泡隔着内边距」由
    // phone-image-flight-3311 浏览器测试覆盖
    bubble.style.borderTopLeftRadius = '12px'
    const img = bubble.appendChild(document.createElement('img'))
    expect(thumbRadius(img), 'a rounded parent that does not clip leaves the picture square').toBe(0)
    bubble.style.overflowX = 'hidden'
    bubble.style.overflowY = 'hidden'
    expect(thumbRadius(img)).toBe(12)
    img.style.borderTopLeftRadius = '6px'
    expect(thumbRadius(img)).toBe(6)
    expect(thumbRadius(null)).toBe(0)
    bubble.remove()
  })

  it('rounds the dragged picture as it shrinks, up to 25px, whatever the thumbnail', () => {
    expect(dragRadius(1)).toBe(0)
    expect(dragRadius(0.9)).toBeCloseTo(7)
    expect(dragRadius(0.7)).toBeCloseTo(21)
    expect(dragRadius(0.4)).toBe(25)
  })

  it('moves on the prototype springs: a soft start, settled in about half a second, no visible overshoot', () => {
    const samples = (easing: string) => easing.replace(/^linear\(|\)$/g, '').split(', ').map(Number)
    for (const spring of [OPEN_SPRING, CLOSE_SPRING, SPRING_BACK]) {
      const { duration, easing } = springCurve(spring)
      const points = samples(easing)
      expect(points[0]).toBe(0)
      expect(points[points.length - 1]).toBe(1)
      expect(duration).toBe(Math.round(((points.length - 1) * 1000) / 60))
      expect(duration).toBeGreaterThan(300)
      expect(duration).toBeLessThan(600)
      expect(Math.max(...points)).toBeLessThan(1.01)
    }
    // 打开那一段:60ms 才走三成、150ms 走七成(原来的 300ms ease 曲线 60ms 就走了近七成,一下就冲到全屏)
    const open = samples(springCurve(OPEN_SPRING).easing)
    expect(open[4]).toBeCloseTo(0.3, 1)
    expect(open[9]).toBeCloseTo(0.71, 1)
  })

  it('only takes over on the phone, for a picture opened from the page', () => {
    const thumb = document.createElement('img')
    expect(usesPhoneFlight(true, { url: 'x', alt: '', thumb })).toBe(true)
    expect(usesPhoneFlight(true, { url: 'x', alt: '', thumbRect: { x: 0, y: 0, width: 1, height: 1 } })).toBe(true)
    expect(usesPhoneFlight(false, { url: 'x', alt: '', thumb })).toBe(false)
    expect(usesPhoneFlight(true, { url: 'x', alt: '' })).toBe(false)
  })
})
