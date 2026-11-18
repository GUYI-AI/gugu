// @@@text-scale — the phone's system font size enlarges text, never the page. The native shell hands the system value
// over as `window.__guguFontScale` before the first script (GuguPageScale.java, GuguViewController.swift) and keeps the
// WebView's own text zoom at 100%, so CSS text and canvas measurements read the same numbers from here:
// - body text (≤16 px roles) follows the system value;
// - titles (20/24 px roles) grow half as much and at most 1.25×, so a page title still fits its header at 150%;
// - boxes, icons, spacing and touch targets stay as written (dp), and a box that holds text grows by its min-height.
// No value (desktop, web) = 1 = the sizes as written. A change while the app runs reloads the page: the transcript's
// measurement config is read once, at startup.

const EVENT = 'gugu:font-scale'
const BODY_MIN = 0.85
const BODY_MAX = 2
const TITLE_MAX = 1.25

declare global {
  interface Window { __guguFontScale?: number }
}

function systemScale(): number {
  const value = window.__guguFontScale
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1
}

export interface TextScale {
  /** Multiplier for body roles (12–16 px). */
  body: number
  /** Multiplier for title roles (20 px and up). */
  title: number
}

export function textScaleFor(system: number): TextScale {
  const body = Math.min(BODY_MAX, Math.max(BODY_MIN, system))
  return { body, title: Math.min(TITLE_MAX, 1 + (body - 1) / 2) }
}

export function textScale(): TextScale {
  return textScaleFor(systemScale())
}

/** A role's px size at the current scale; the one curve both CSS (tokens.css) and canvas measurement use. */
export function scaledTextPx(px: number, scale: TextScale = textScale()): number {
  return px * (px >= 20 ? scale.title : scale.body)
}

export function installTextScale(): void {
  const applied = systemScale()
  const { body, title } = textScaleFor(applied)
  const root = document.documentElement.style
  root.setProperty('--text-scale', String(body))
  root.setProperty('--title-scale', String(title))
  window.addEventListener(EVENT, () => {
    if (systemScale() !== applied) window.location.reload()
  })
}
