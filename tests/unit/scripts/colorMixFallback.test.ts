import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
import { addColorMixFallbacks } from '../../../scripts/build/color-mix-fallback.mts'

const run = (...css: string[]) => {
  const sheets = css.map(c => postcss.parse(c))
  const report = addColorMixFallbacks(sheets)
  return { report, out: sheets.map(s => s.toString()) }
}

describe('color-mix fallbacks from the root tokens', () => {
  it('evaluates a token mixed from the theme palette, per theme, right after the original rule', () => {
    const { report, out } = run(
      ':root{--fg:#fafafa;--hover:color-mix(in oklab,var(--fg) 4%,transparent)}[data-theme=light]{--fg:#0a0a0a}',
      '.row{background:var(--hover)}.cta{border-color:color-mix(in srgb,var(--fg) 50%,transparent)}.next{color:red}',
    )
    expect(report).toEqual({ written: 2, unresolved: 0 })
    expect(out[0]).toContain('@supports not (color: color-mix(in srgb, red, blue))')
    expect(out[0]).toMatch(/:root:where\(\[data-theme=light\]\)\s*\{\s*--hover:\s*#0a0a0a0a/)
    expect(out[0]).toMatch(/:root:where\(\[data-theme=dark\]\)\s*\{\s*--hover:\s*#fafafa0a/)
    expect(out[1]).toMatch(/\.cta\{border-color:color-mix[^}]*\}@supports not[^{]*\{\s*:where\(\[data-theme=light\]\) \.cta/)
    expect(out[1].indexOf('@supports')).toBeLessThan(out[1].indexOf('.next'))
  })

  it('writes one rule when both themes give the same value, and none for what the root tokens cannot settle', () => {
    const { report, out } = run(
      ':root{--live:#3c82f6}',
      '.a{background:color-mix(in srgb,var(--live) 20%,transparent)}.b{color:color-mix(in srgb,currentColor 50%,var(--live))}.c{color:color-mix(in srgb,var(--em-x) 50%,white)}',
    )
    expect(report).toEqual({ written: 1, unresolved: 2 })
    expect(out[1]).toMatch(/@supports not[^{]*\{\s*\.a\s*\{\s*background:\s*#3c82f633/)
    expect(out[1]).not.toContain(':where(')
  })

  it('reads Tailwind\'s guarded value, not its full-strength stand-in, and lands after the guard', () => {
    const { report, out } = run(
      ':root{--fg:#0a0a0a;--hover:var(--fg)}@supports (color:color-mix(in lab, red, red)){:root{--hover:color-mix(in oklab,var(--fg) 4%,transparent)}}',
      '.row{background:var(--fg)}@supports (color:color-mix(in lab, red, red)){.row{background:color-mix(in oklab,var(--hover) 50%,transparent)}}.after{color:red}',
    )
    expect(report).toEqual({ written: 2, unresolved: 0 })
    expect(out[0]).toMatch(/\}\}@supports not[^{]*\{\s*\.?:root\s*\{\s*--hover:\s*#0a0a0a0a/)
    expect(out[1]).toMatch(/\}\}@supports not[^{]*\{\s*\.row\s*\{\s*background:\s*#0a0a0a05/)
    expect(out[1].indexOf('@supports not')).toBeLessThan(out[1].indexOf('.after'))
  })
})
