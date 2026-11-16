// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installTextScale, scaledTextPx, textScaleFor } from '../../../../apps/desktop/src/mobile/textScale'

// The phone's system font size scales text through two root variables; the page's viewport is never touched.
afterEach(() => {
  delete window.__guguFontScale
  document.documentElement.removeAttribute('style')
})

describe('text follows the system font size', () => {
  it('writes 1 without a value (desktop, web)', () => {
    installTextScale()
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1')
    expect(document.documentElement.style.getPropertyValue('--title-scale')).toBe('1')
  })

  it('scales body text with the system and titles half as much, at most 1.25×', () => {
    expect(textScaleFor(1.3)).toEqual({ body: 1.3, title: 1.15 })
    expect(textScaleFor(1.5)).toEqual({ body: 1.5, title: 1.25 })
    expect(textScaleFor(2.4)).toEqual({ body: 2, title: 1.25 })
    expect(textScaleFor(0.5)).toEqual({ body: 0.85, title: 0.925 })
  })

  it('gives CSS and canvas measurement the same px per role', () => {
    window.__guguFontScale = 1.3
    installTextScale()
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.3')
    expect(scaledTextPx(16)).toBeCloseTo(20.8)
    expect(scaledTextPx(24)).toBeCloseTo(27.6)
  })
})
