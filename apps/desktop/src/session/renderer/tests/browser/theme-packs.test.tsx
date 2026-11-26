// 资源库「主题」在真浏览器里:Obsidian 的 theme.css 在沙盒里算出颜色;选中的配色真的压过 tokens.css。
import { afterEach, beforeEach, expect, it } from 'vitest'
import { evaluateObsidianCss } from '@/session/renderer/lib/theme/theme-pack-import'
import {
  applyThemePackSlots,
  chooseThemePack,
  DEFAULT_THEME_PACK_ID,
  readStoredThemePackSlots,
  readThemePackSlots,
  resetThemePacks,
  restoreThemePackChoice,
  setUnchosenThemePack,
} from '@/session/renderer/lib/theme/theme-pack-store'
import { writeThemePreference } from '@/session/renderer/lib/theme/host-theme'
import { groundCss, resolvePalette } from '@/session/renderer/lib/theme/theme-packs'
import { appThemeColors } from '@/session/renderer/lib/theme/app-theme-colors'
import { applyThemeColors } from '@/session/app-runtime/theme-colors'
import { BUILTIN_THEME_PACKS } from '@/session/renderer/lib/theme/theme-pack-store'
import '@/styles/tokens.css'

beforeEach(() => {
  localStorage.clear()
  writeThemePreference('light')
})
afterEach(() => {
  resetThemePacks()
  localStorage.clear()
})

it('evaluates an Obsidian theme in the sandbox: hsl()/calc()/var() resolve per mode, and the sandbox is torn down', async () => {
  const vars = await evaluateObsidianCss(`
    @import url("https://example.invalid/evil.css");
    body { --accent-h: 210; --accent-s: 80%; --accent-l: 60%; }
    .theme-dark { --background-primary: #1e1e2e; --background-secondary: rgb(24 24 37); --text-normal: #cdd6f4;
      --interactive-accent: hsl(var(--accent-h), var(--accent-s), var(--accent-l));
      background-image: url("https://example.invalid/track.png"); }
    .theme-light { --background-primary: #eff1f5; --text-normal: #4c4f69;
      --interactive-accent: hsl(var(--accent-h), var(--accent-s), calc(var(--accent-l) - 20%)); }
  `)
  expect(vars.dark).toMatchObject({ '--background-primary': '#1e1e2eff', '--background-secondary': '#181825ff', '--text-normal': '#cdd6f4ff' })
  expect(vars.dark?.['--interactive-accent']).toBe('#4799ebff')
  expect(vars.light?.['--background-primary']).toBe('#eff1f5ff')
  expect(vars.light?.['--background-secondary']).toBeUndefined()
  expect(document.querySelectorAll('iframe')).toHaveLength(0)
})

it('a chosen pack out-ranks tokens.css on the root, in both modes', () => {
  const pack = BUILTIN_THEME_PACKS.find((p) => p.id === 'tokyo-night')!
  chooseThemePack(pack.id)
  const read = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  expect(read('--bg')).toBe(resolvePalette(pack.modes.light!, 'light').bg)
  // The window ground is drawn by a more specific rule (the window material); it still takes the theme's ground.
  document.documentElement.dataset.windowMaterial = 'opaque'
  expect(read('--shell-bg')).toBe(groundCss(resolvePalette(pack.modes.light!, 'light').ground))
  delete document.documentElement.dataset.windowMaterial
  writeThemePreference('dark')
  expect(read('--bg')).toBe(resolvePalette(pack.modes.dark!, 'dark').bg)
  expect(read('--muted-fg')).toBe(resolvePalette(pack.modes.dark!, 'dark').mutedFg)
  resetThemePacks()
  expect(read('--bg')).toBe('#0f0f0f')
})

it('a machine that never chose a theme gets the host default; choosing Gugu default stays a choice', () => {
  const github = BUILTIN_THEME_PACKS.find((p) => p.id === DEFAULT_THEME_PACK_ID)!
  const bg = () => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  setUnchosenThemePack(DEFAULT_THEME_PACK_ID)
  try {
    writeThemePreference('dark')
    applyThemePackSlots()
    expect(readStoredThemePackSlots()).toBeNull()
    expect(bg()).toBe(resolvePalette(github.modes.dark!, 'dark').bg)
    // A single-mode pick fills its own slot; the other mode stays on the default.
    const before = chooseThemePack('dracula')
    expect(readThemePackSlots()).toEqual({ dark: 'dracula', light: DEFAULT_THEME_PACK_ID })
    // Undo goes back to "never chose", not to a stored copy of the default.
    restoreThemePackChoice(before)
    expect(readStoredThemePackSlots()).toBeNull()
    expect(bg()).toBe(resolvePalette(github.modes.dark!, 'dark').bg)
    // Picking Gugu default is stored ({}), so a later default never replaces it.
    resetThemePacks()
    expect(readStoredThemePackSlots()).toEqual({})
    expect(bg()).toBe('#0f0f0f')
  } finally {
    setUnchosenThemePack(null)
  }
})

it('App pages get the palette in the theme\'s values; no theme, nothing, and the build\'s palette stands', () => {
  expect(appThemeColors()).toBeUndefined()
  const pack = BUILTIN_THEME_PACKS.find((p) => p.id === 'tokyo-night')!
  chooseThemePack(pack.id)
  const light = resolvePalette(pack.modes.light!, 'light')
  expect(appThemeColors()).toMatchObject({ '--em-background': light.bg, '--em-foreground': light.fg, '--em-background-3': light.muted })
  writeThemePreference('dark')
  expect(appThemeColors()?.['--em-background']).toBe(resolvePalette(pack.modes.dark!, 'dark').bg)
  resetThemePacks()
  expect(appThemeColors()).toBeUndefined()
})

it('a dark-only theme leaves App pages on the default in light', () => {
  chooseThemePack('dracula')
  expect(appThemeColors()?.['--em-background']).toBeTruthy()
  writeThemePreference('light')
  expect(appThemeColors()).toBeUndefined()
})

it('on a page, the theme\'s colors beat ui.css whichever loads first, and leave with the theme', () => {
  const root = document.documentElement
  const ui = () => {
    const sheet = document.createElement('style')
    sheet.textContent = '@layer gugu { :root[data-gugu-theme="dark"] { --em-background: #181818; } }'
    return document.head.appendChild(sheet)
  }
  root.dataset.guguTheme = 'dark'
  const read = () => getComputedStyle(root).getPropertyValue('--em-background').trim()
  const before = ui()
  applyThemeColors({ '--em-background': '#112233' })
  expect(read()).toBe('#112233')
  const after = ui()
  expect(read()).toBe('#112233')
  applyThemeColors(undefined)
  expect(read()).toBe('#181818')
  before.remove()
  after.remove()
  delete root.dataset.guguTheme
})
