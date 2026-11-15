// @@@page-scale — the phone's system font size is this page's zoom (GuguPageScale.java): the shell keeps the WebView's
// text zoom at 100% and hands the scale over as `window.__guguFontScale`; the page lays out in a viewport that much
// narrower (a 412 px screen at 1.3 → 317 px) and is drawn that much larger, text and boxes alike, so a canvas
// measurement and the laid-out text always agree. No value (desktop, web, an old WebView) = 1 = the viewport as written.

const EVENT = 'gugu:font-scale'

declare global {
  interface Window { __guguFontScale?: number }
}

function fontScale(): number {
  const value = window.__guguFontScale
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

/** The zoom this page is drawn at when nobody pinches: the visual viewport's scale at rest. */
export function pageZoom(): number {
  return fontScale() === 1 ? 1 : window.screen.width / layoutWidth(fontScale())
}

function layoutWidth(scale: number): number {
  return Math.round(window.screen.width / scale)
}

export function installPageScale(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (!meta) throw new Error('page-scale: index.html has no viewport meta')
  const written = meta.content
  const apply = () => {
    const scale = fontScale(), zoom = pageZoom()
    meta.content = scale === 1 ? written
      : `width=${layoutWidth(scale)}, initial-scale=${zoom}, maximum-scale=${zoom}, user-scalable=no`
  }
  apply()
  window.addEventListener(EVENT, apply)
  // screen.width is the other input: it changes when the phone turns.
  window.screen.orientation?.addEventListener('change', apply)
}
