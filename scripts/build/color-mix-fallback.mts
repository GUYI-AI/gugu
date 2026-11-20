// @@@color-mix-fallback - sRGB values for color-mix() on engines that lack it (below Chrome 111 / Safari 16.2).
//
// Most of our color-mix() calls take var() arguments (`--hover: color-mix(in oklab, var(--fg) 4%, transparent)`), which no
// stylesheet transform can evaluate in place. But the vars they name are the theme tokens, set on the root element by
// `:root` (the dark palette) and `[data-theme="light"]` / `[data-theme="dark"]`, and those are literals. So, per theme:
// substitute the tokens, let lightningcss evaluate the now-static color-mix(), and write the result in a rule placed
// right after the original, inside `@supports not (color: color-mix(...))`. Newer engines never read it; older ones get a
// value where they had none. Placement keeps the cascade: the fallback has the original's specificity (theme qualifiers
// go in :where()) and sits where the original sat.
//
// Tailwind already wraps each color-mix() it sees in `@supports (color: color-mix(in lab, red, red))` and leaves a lossy
// stand-in outside (the mixed token at full strength: our black send-capsule borders and chips on Chrome 109). Its guarded
// value is the one read here, and the fallback goes after the guard so it replaces the stand-in.
//
// A value that still names something the root tokens do not settle (currentColor, a token set below the root such as the
// session page's --em-*, a theme pack applied at runtime) keeps no fallback; the build log counts those.
import postcss, { type AtRule, type Declaration, type Root, type Rule } from 'postcss'
import { transform } from 'lightningcss'
import type { Plugin } from 'vite'
import { ENGINE_FLOOR } from './engine-floor.mts'

type Theme = 'light' | 'dark'
const THEMES: Theme[] = ['light', 'dark']
const SUPPORTS = 'not (color: color-mix(in srgb, red, blue))'

/** A selector that addresses the root element as a theme scope: '' for the default palette, or the theme it is for. */
function rootScope(selector: string): '' | Theme | null {
  const s = selector.replace(/\s+/g, '').replace(/"/g, '')
  if (s === ':root' || s === 'html' || s === ':host') return ''
  const m = /^(?::root)?\[data-theme=(light|dark)\]$/.exec(s)
  return m ? (m[1] as Theme) : null
}

/** Tailwind's guard around the real value: `@supports (color: color-mix(in lab, red, red))`. Its base rule carries a lossy
 * stand-in (`--hover: var(--fg)`, the percentage dropped), which is what an older engine paints: full-strength ink. */
function colorMixGuard(rule: Rule): AtRule | null {
  const p = rule.parent
  return p?.type === 'atrule' && (p as AtRule).name === 'supports' && /^\(\s*color\s*:\s*color-mix\(/.test((p as AtRule).params)
    ? (p as AtRule) : null
}

/** Inside @supports / @media other than Tailwind's color-mix guard: a value only some engines or viewports take. */
function conditional(rule: Rule): boolean {
  for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
    if (p === colorMixGuard(rule)) continue
    if (p.type === 'atrule' && ['supports', 'media', 'container'].includes((p as AtRule).name)) return true
  }
  return false
}

/** Root tokens per theme. `:root` holds the default (dark) palette; a theme's own rule overrides it. */
function collectTokens(sheets: Root[]): Record<Theme, Map<string, string>> {
  const base = new Map<string, string>()
  const own: Record<Theme, Map<string, string>> = { light: new Map(), dark: new Map() }
  for (const sheet of sheets) {
    sheet.walkRules(rule => {
      if (conditional(rule)) return
      const scopes = rule.selectors.map(rootScope)
      if (scopes.some(s => s === null)) return
      for (const decl of rule.nodes) {
        if (decl.type !== 'decl' || !decl.prop.startsWith('--')) continue
        for (const scope of new Set(scopes)) (scope === '' ? base : own[scope as Theme]).set(decl.prop, decl.value)
      }
    })
  }
  return { light: new Map([...base, ...own.light]), dark: new Map([...base, ...own.dark]) }
}

/** Replace every var() with its token value, recursively; null when something stays unknown. */
function substitute(value: string, tokens: Map<string, string>, depth = 0): string | null {
  if (depth > 12) return null
  let out = ''
  let i = 0
  while (i < value.length) {
    const at = value.indexOf('var(', i)
    if (at < 0) { out += value.slice(i); break }
    out += value.slice(i, at)
    let level = 0
    let end = at + 3
    let comma = -1
    for (; end < value.length; end++) {
      const ch = value[end]
      if (ch === '(') level++
      else if (ch === ')') { level--; if (level === 0) break }
      else if (ch === ',' && level === 1 && comma < 0) comma = end
    }
    const name = value.slice(at + 4, comma < 0 ? end : comma).trim()
    const fallback = comma < 0 ? null : value.slice(comma + 1, end).trim()
    const raw = tokens.get(name) ?? fallback
    if (raw == null) return null
    const resolved = substitute(raw, tokens, depth + 1)
    if (resolved == null) return null
    out += resolved
    i = end + 1
  }
  return out
}

/** lightningcss evaluates static color-mix(); its first declaration for the property is the sRGB one. */
function evaluate(prop: string, value: string): string | null {
  if (/currentcolor/i.test(value)) return null
  // A custom property has no type; try it where a lone color, then a shadow or a border, would be read.
  const probes = prop.startsWith('--') ? ['color', 'box-shadow', 'border'] : [prop]
  for (const probe of probes) {
    try {
      const { code, warnings } = transform({
        filename: 'color-mix-fallback.css',
        code: Buffer.from(`a{${probe}:${value}}`),
        targets: { chrome: ENGINE_FLOOR.chrome << 16 },
        minify: true,
      })
      if (warnings.length) continue
      const decl = new RegExp(`[{;]${probe}:([^;}]*)`).exec(code.toString())?.[1]
      if (decl && !decl.includes('color-mix(') && !decl.includes('var(')) return decl
    } catch { /* not a value of this property; try the next */ }
  }
  return null
}

function scoped(selector: string, theme: Theme): string {
  return rootScope(selector) !== null ? `${selector}:where([data-theme=${theme}])` : `:where([data-theme=${theme}]) ${selector}`
}

export interface FallbackReport { written: number; unresolved: number }

export function addColorMixFallbacks(sheets: Root[]): FallbackReport {
  const tokens = collectTokens(sheets)
  const report: FallbackReport = { written: 0, unresolved: 0 }
  for (const sheet of sheets) {
    const rules: Rule[] = []
    sheet.walkRules(rule => { rules.push(rule) })
    for (const rule of rules) {
      if (conditional(rule)) continue
      const decls = rule.nodes.filter((n): n is Declaration => n.type === 'decl' && n.value.includes('color-mix(') && n.value.includes('var('))
      if (decls.length === 0) continue
      const perTheme: Record<Theme, Declaration[]> = { light: [], dark: [] }
      for (const decl of decls) {
        const values = THEMES.map(theme => {
          const substituted = substitute(decl.value, tokens[theme])
          return substituted == null ? null : evaluate(decl.prop, substituted)
        })
        if (values.some(v => v == null)) { report.unresolved++; continue }
        THEMES.forEach((theme, i) => perTheme[theme].push(postcss.decl({ prop: decl.prop, value: values[i]!, important: decl.important })))
        report.written++
      }
      if (perTheme.light.length === 0) continue
      const block = postcss.atRule({ name: 'supports', params: SUPPORTS })
      const same = perTheme.light.every((d, i) => d.value === perTheme.dark[i]!.value)
      if (same) block.append(postcss.rule({ selectors: rule.selectors, nodes: perTheme.light }))
      else for (const theme of THEMES) block.append(postcss.rule({ selectors: rule.selectors.map(s => scoped(s, theme)), nodes: perTheme[theme] }))
      // After Tailwind's guard when there is one, so it overrides the lossy stand-in in the base rule before it.
      ;(colorMixGuard(rule) ?? rule).after(block)
    }
  }
  return report
}

/** Runs on the emitted stylesheets, after minification, so it reads the same tokens the engine will. */
export function colorMixFallback(): Plugin {
  return {
    name: 'gugu-color-mix-fallback',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = Object.values(bundle).filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
      const sheets = assets.map(asset => postcss.parse(String((asset as { source: string | Uint8Array }).source)))
      const report = addColorMixFallbacks(sheets)
      sheets.forEach((sheet, i) => { (assets[i] as { source: string }).source = sheet.toString() })
      this.info(`color-mix fallbacks: ${report.written} written, ${report.unresolved} left without (no root token settles them)`)
    },
  }
}
