// 资源库「主题」(owner 2026-11-07):上游配色 → 咕咕的 canonical 变量,对比度兜底,vsix 解析,链接解析。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Color from 'colorjs.io'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { BUILTIN_THEME_PACKS } from '../../../../apps/desktop/src/session/renderer/lib/theme/theme-pack-store'
import { parseThemeLink, ThemeImportError } from '../../../../apps/desktop/src/session/renderer/lib/theme/theme-pack-import'
import { pickVariants, readVsix } from '../../../../apps/desktop/src/session/renderer/lib/theme/theme-pack-vsix'
import {
  CONTRAST_FLOORS,
  MIN_TEXT_STEP,
  GUGU_DEFAULT_SWATCH,
  packModes,
  paletteFromObsidian,
  paletteFromVSCode,
  paletteIsReadable,
  resolvePalette,
  themePackStylesheet,
  type PaletteRole,
} from '../../../../apps/desktop/src/session/renderer/lib/theme/theme-packs'

const root = join(__dirname, '../../../..')
const tokens = readFileSync(join(root, 'apps/desktop/src/styles/tokens.css'), 'utf8')

const contrastRatio = (a: string, b: string) => new Color(a).contrast(new Color(b), 'WCAG21')
const oklabLightness = (value: string) => new Color(value).to('oklab').coords[0]

describe('large surfaces', () => {
  const pack = (id: string) => BUILTIN_THEME_PACKS.find((p) => p.id === id)!

  it('keep a theme\'s hue but not a whole window of saturated color', () => {
    const raw = pack('gruvbox').modes.light!
    expect(raw.bg).toBe('#fbf1c7')
    const p = resolvePalette(raw, 'light')
    const lch = (value: string) => new Color(value).to('oklch').coords
    for (const surface of [p.page, p.bg, p.card, p.muted]) expect(lch(surface)[1]).toBeLessThanOrEqual(0.0285)
    expect(Math.abs(lch(p.bg)[2] - lch(raw.bg)[2])).toBeLessThan(3)
  })

  it('use the theme\'s own lower layer when its side bar is the same color as its content', () => {
    const raw = pack('gruvbox').modes.light!
    expect(raw.page).toBe(raw.bg)
    const p = resolvePalette(raw, 'light')
    expect(oklabLightness(p.bg) - oklabLightness(p.page)).toBeGreaterThanOrEqual(0.012)
    expect(p.page).not.toBe(p.bg)
  })

  it('lift a dim light content surface, the whole ladder with it', () => {
    const raw = pack('tokyo-night').modes.light!
    const p = resolvePalette(raw, 'light')
    expect(oklabLightness(p.bg)).toBeGreaterThanOrEqual(0.954)
    expect(oklabLightness(p.bg) - oklabLightness(p.page)).toBeCloseTo(oklabLightness(raw.bg) - oklabLightness(raw.page!), 2)
  })
})

describe('a palette the guard cannot save', () => {
  it('a mid-gray background is refused: no text color reaches the body floor on it', () => {
    expect(paletteIsReadable({ bg: '#6e6e6e', fg: '#ffffff' }, 'dark')).toBe(false)
  })

  it('every built-in palette passes', () => {
    for (const pack of BUILTIN_THEME_PACKS) for (const mode of packModes(pack)) expect(paletteIsReadable(pack.modes[mode]!, mode), `${pack.id} ${mode}`).toBe(true)
  })
})

describe('the raised-contrast system setting', () => {
  it('still raises secondary and decorative text under a theme, which out-ranks the rule in tokens.css', () => {
    const css = themePackStylesheet({ dark: BUILTIN_THEME_PACKS.find((p) => p.id === 'tokyo-night') })
    expect(css).toMatch(/@media \(prefers-contrast: more\) \{\s*:root\[data-theme='dark'\] \{ --muted-fg: var\(--fg\); --faint-fg: var\(--fg\); \}/)
  })
})

describe('built-in theme packs', () => {
  it('ship seven families, each MIT or Apache-2.0, each credited in THIRD_PARTY_NOTICES.md', () => {
    const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    expect(BUILTIN_THEME_PACKS.map((p) => p.id)).toEqual(['tokyo-night', 'catppuccin', 'github', 'gruvbox', 'everforest', 'rose-pine', 'dracula'])
    for (const pack of BUILTIN_THEME_PACKS) {
      expect(['MIT', 'Apache-2.0'], pack.id).toContain(pack.source.license)
      expect(notices, `${pack.id} credited`).toContain(`### ${pack.name}`)
      expect(notices, `${pack.id} credited with its version`).toContain(`${pack.source.version} — ${pack.source.url}`)
    }
  })

  // 每族 × 每种明暗,兜底之后每个角色对它会落在的每种底色都过线 —— 全量,❌ 抽样。
  it.each(BUILTIN_THEME_PACKS.flatMap((pack) => packModes(pack).map((mode) => [pack.id, mode, pack] as const)))(
    '%s (%s): every text role clears its floor on every surface it sits on',
    (_id, mode, pack) => {
      const p = resolvePalette(pack.modes[mode]!, mode)
      const surfaces = { page: p.page, bg: p.bg, card: p.card, muted: p.muted }
      const colorOf: Record<PaletteRole, string> = { fg: p.fg, mutedFg: p.mutedFg, faintFg: p.faintFg, live: p.live, dangerFg: p.dangerFg, warnFg: p.warnFg, okFg: p.okFg }
      for (const [role, { min, on }] of Object.entries(CONTRAST_FLOORS) as Array<[PaletteRole, (typeof CONTRAST_FLOORS)[PaletteRole]]>) {
        for (const surface of on) {
          expect(contrastRatio(colorOf[role], surfaces[surface]), `${role} on ${surface}`).toBeGreaterThanOrEqual(min)
        }
      }
      // 表面阶梯:窗口底层低于内容;深色时浮层高于内容、浅色时不低于内容;填充面与卡片分得开。
      expect(oklabLightness(p.bg) - oklabLightness(p.page)).toBeGreaterThanOrEqual(0.012)
      if (mode === 'dark') expect(oklabLightness(p.card) - oklabLightness(p.bg)).toBeGreaterThanOrEqual(0.02)
      else expect(oklabLightness(p.card)).toBeGreaterThanOrEqual(oklabLightness(p.bg))
      const step = mode === 'dark' ? oklabLightness(p.muted) - oklabLightness(p.card) : oklabLightness(p.card) - oklabLightness(p.muted)
      expect(step).toBeGreaterThan(0.015)
    },
  )

  it('keeps secondary text distinct from body text when upstream gives both the same colour', () => {
    const gruvbox = BUILTIN_THEME_PACKS.find((p) => p.id === 'gruvbox')!
    const raw = gruvbox.modes.dark!
    expect(raw.mutedFg).toBe(raw.fg)
    const dark = resolvePalette(raw, 'dark')
    expect(Math.abs(oklabLightness(dark.mutedFg) - oklabLightness(dark.fg))).toBeGreaterThanOrEqual(MIN_TEXT_STEP)
    expect(contrastRatio(dark.mutedFg, dark.muted)).toBeGreaterThanOrEqual(4.5)
  })

  it('lifts unreadable upstream text over the floor, moving lightness only', () => {
    const tokyo = BUILTIN_THEME_PACKS.find((p) => p.id === 'tokyo-night')!
    const dark = resolvePalette(tokyo.modes.dark!, 'dark')
    // 上游 descriptionForeground #515670 在 #1a1b26 上只有 ~2.4:1。
    expect(tokyo.modes.dark!.mutedFg).toBe('#515670')
    expect(contrastRatio('#515670', dark.bg)).toBeLessThan(2.5)
    expect(contrastRatio(dark.mutedFg, dark.bg)).toBeGreaterThanOrEqual(4.5)
    const hue = (value: string) => new Color(value).to('oklch').coords[2]
    expect(Math.abs(hue(dark.mutedFg) - hue('#515670'))).toBeLessThan(3)
  })

  it('the "Gugu default" preview swatch is a verbatim copy of tokens.css', () => {
    const values = (name: string) => [...tokens.matchAll(new RegExp(`^\\s*--${name}:\\s*(#[0-9a-fA-F]{6})\\b`, 'gm'))].map((m) => m[1].toLowerCase())
    for (const [key, token] of [['bg', 'bg'], ['page', 'page'], ['card', 'card'], ['fg', 'fg'], ['mutedFg', 'muted-fg']] as const) {
      expect(values(token).slice(0, 2), token).toEqual([GUGU_DEFAULT_SWATCH.dark[key], GUGU_DEFAULT_SWATCH.light[key]])
    }
    expect(tokens).toContain(`--live-dark: ${GUGU_DEFAULT_SWATCH.dark.live};`)
    expect(tokens).toContain(`--live-light: ${GUGU_DEFAULT_SWATCH.light.live};`)
  })
})

describe('themePackStylesheet', () => {
  const pack = BUILTIN_THEME_PACKS.find((p) => p.id === 'catppuccin')!

  it('writes one rule per filled slot, out-ranking tokens.css (0,1,0) with (0,2,0)', () => {
    const css = themePackStylesheet({ dark: pack, light: pack })
    expect(css).toMatch(/^:root\[data-theme='dark'\] \{/m)
    expect(css).toMatch(/^:root\[data-theme='light'\] \{/m)
    expect(themePackStylesheet({ dark: pack })).not.toContain("data-theme='light'")
    expect(themePackStylesheet({})).toBe('')
  })

  it('overrides the live tier (--live-dark / --live-light), never --live itself', () => {
    const css = themePackStylesheet({ dark: pack, light: pack })
    expect(css).toContain('--live-dark:')
    expect(css).toContain('--live-light:')
    expect(css).not.toMatch(/--live:/)
  })

  it('every variable it writes is a variable tokens.css declares', () => {
    const written = [...themePackStylesheet({ dark: pack, light: pack }).matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1])
    for (const name of new Set(written)) expect(tokens, name).toMatch(new RegExp(`${name}\\s*:`))
  })
})

describe('paletteFromVSCode', () => {
  it('prefers the editor error colour over a grey errorForeground, and composites alpha onto the editor', () => {
    const raw = paletteFromVSCode({
      'editor.background': '#1a1b26',
      'editor.foreground': '#a9b1d6',
      errorForeground: '#515670',
      'editorError.foreground': '#db4b4b',
      'button.background': '#3d59a1dd',
    })!
    expect(raw.danger).toBe('#db4b4b')
    // 没有 textLink / progressBar / badge:退到按钮色,且 dd 透明度合成到编辑器底上。
    expect(raw.live).toMatch(/^#[0-9a-f]{6}$/)
    expect(raw.live).not.toBe('#3d59a1')
  })

  it('returns null without an editor background or foreground', () => {
    expect(paletteFromVSCode({ 'editor.foreground': '#fff' })).toBeNull()
    expect(paletteFromVSCode({ 'editor.background': '#000' })).toBeNull()
  })
})

describe('paletteFromObsidian', () => {
  it('maps the Obsidian variables', () => {
    const raw = paletteFromObsidian({
      '--background-primary': '#1e1e2e',
      '--background-secondary': '#181825ff',
      '--text-normal': '#cdd6f4',
      '--text-muted': '#a6adc8',
      '--interactive-accent': '#89b4fa',
    })!
    expect(raw).toMatchObject({ bg: '#1e1e2e', page: '#181825', fg: '#cdd6f4', mutedFg: '#a6adc8', live: '#89b4fa' })
  })
})

async function vsix(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, text] of Object.entries(files)) zip.file(path, text)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('readVsix', () => {
  it('reads JSONC theme files (comments, trailing commas), follows include, skips high contrast, trusts the background', async () => {
    const bytes = await vsix({
      'extension/package.json': JSON.stringify({
        name: 'night', displayName: 'Night', publisher: 'someone', version: '1.0.0', license: 'MIT',
        contributes: {
          themes: [
            { label: 'Night', uiTheme: 'vs-dark', path: './themes/night.json' },
            { label: 'Night HC', uiTheme: 'hc-black', path: './themes/night.json' },
            { label: 'Mislabelled', uiTheme: 'vs-dark', path: './themes/day.json' },
          ],
        },
      }),
      'extension/themes/base.json': `{ "colors": { "editor.foreground": "#c0caf5", "textLink.foreground": "#7aa2f7", } }`,
      'extension/themes/night.json': `{
        // the night
        "include": "./base.json",
        "colors": {
          "editor.background": "#1a1b26", // trailing comment
        },
      }`,
      'extension/themes/day.json': `{ "colors": { "editor.background": "#fafafa", "editor.foreground": "#222222" } }`,
    })
    const contents = await readVsix(bytes)
    expect(contents).toMatchObject({ displayName: 'Night', publisher: 'someone', version: '1.0.0', license: 'MIT' })
    expect(contents.themes.map((t) => [t.label, t.mode])).toEqual([['Night', 'dark'], ['Night HC', null], ['Mislabelled', 'light']])
    expect(contents.themes[0].palette).toMatchObject({ bg: '#1a1b26', fg: '#c0caf5', live: '#7aa2f7' })
    const picked = pickVariants(contents.themes)
    expect(picked.dark?.label).toBe('Night')
    expect(picked.light?.label).toBe('Mislabelled')
    expect(() => pickVariants(contents.themes, { dark: 'Nope' })).toThrow()
  })
})

describe('parseThemeLink', () => {
  it('understands Open VSX extension pages and GitHub repositories', () => {
    expect(parseThemeLink('https://open-vsx.org/extension/enkia/tokyo-night')).toEqual({ kind: 'vscode', namespace: 'enkia', name: 'tokyo-night' })
    expect(parseThemeLink(' https://open-vsx.org/extension/enkia/tokyo-night/1.1.2 ')).toEqual({ kind: 'vscode', namespace: 'enkia', name: 'tokyo-night' })
    expect(parseThemeLink('https://github.com/catppuccin/obsidian.git')).toEqual({ kind: 'obsidian', owner: 'catppuccin', repo: 'obsidian' })
    expect(parseThemeLink('https://github.com/kepano/obsidian-minimal/tree/master')).toEqual({ kind: 'obsidian', owner: 'kepano', repo: 'obsidian-minimal' })
  })

  it('refuses the VS Code Marketplace by name, and anything else as unsupported', () => {
    const code = (input: string) => {
      try {
        parseThemeLink(input)
      } catch (error) {
        return (error as ThemeImportError).code
      }
      return null
    }
    expect(code('https://marketplace.visualstudio.com/items?itemName=enkia.tokyo-night')).toBe('marketplace')
    expect(code('https://example.com/theme')).toBe('unsupported-url')
    expect(code('not a link')).toBe('unsupported-url')
  })
})

