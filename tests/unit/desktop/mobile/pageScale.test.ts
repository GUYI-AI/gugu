// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installPageScale, pageZoom } from '../../../../apps/desktop/src/mobile/pageScale'

// The phone's system font size becomes the page's zoom (GuguPageScale.java hands it over as window.__guguFontScale):
// the page lays out in a viewport that much narrower and is drawn that much larger, text and boxes alike.
const WRITTEN = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'
let meta: HTMLMetaElement

beforeEach(() => {
  meta = document.createElement('meta')
  meta.name = 'viewport'
  meta.content = WRITTEN
  document.head.append(meta)
  Object.defineProperty(window.screen, 'width', { value: 412, configurable: true })
})
afterEach(() => {
  meta.remove()
  delete window.__guguFontScale
})

describe('the viewport follows the system font size', () => {
  it('leaves the written viewport alone without a scale (desktop, web, an old WebView)', () => {
    installPageScale()
    expect(meta.content).toBe(WRITTEN)
    expect(pageZoom()).toBe(1)
  })

  it('lays a 412 px screen at 130% out in 317 px and draws it at the matching zoom', () => {
    window.__guguFontScale = 1.3
    installPageScale()
    expect(meta.content).toBe(`width=317, initial-scale=${412 / 317}, maximum-scale=${412 / 317}, user-scalable=no`)
    expect(pageZoom()).toBeCloseTo(1.3, 2)
  })

  it('takes a change while the app runs, back to the written viewport at 100%', () => {
    window.__guguFontScale = 1.15
    installPageScale()
    expect(meta.content.startsWith('width=358,')).toBe(true)
    window.__guguFontScale = 1
    window.dispatchEvent(new Event('gugu:font-scale'))
    expect(meta.content).toBe(WRITTEN)
  })
})
