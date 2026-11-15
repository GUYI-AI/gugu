// 资源库「主题」在真浏览器里:Obsidian 的 theme.css 在沙盒里算出颜色;选中的配色真的压过 tokens.css。
import { afterEach, beforeEach, expect, it } from 'vitest'
import { evaluateObsidianCss } from '@/session/renderer/lib/theme/theme-pack-import'
import { chooseThemePack, resetThemePacks } from '@/session/renderer/lib/theme/theme-pack-store'
import { writeThemePreference } from '@/session/renderer/lib/theme/host-theme'
import { resolvePalette } from '@/session/renderer/lib/theme/theme-packs'
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
  writeThemePreference('dark')
  expect(read('--bg')).toBe(resolvePalette(pack.modes.dark!, 'dark').bg)
  expect(read('--muted-fg')).toBe(resolvePalette(pack.modes.dark!, 'dark').mutedFg)
  resetThemePacks()
  expect(read('--bg')).toBe('#181818')
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
