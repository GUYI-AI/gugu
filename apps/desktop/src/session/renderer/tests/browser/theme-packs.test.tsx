// 资源库「主题」在真浏览器里:Obsidian 的 theme.css 在沙盒里算出颜色;选中的配色真的压过 tokens.css。
import { afterEach, beforeEach, expect, it } from 'vitest'
import { evaluateObsidianCss } from '@/session/renderer/lib/theme/theme-pack-import'
import { chooseThemePack, resetThemePacks } from '@/session/renderer/lib/theme/theme-pack-store'
import { writeThemePreference } from '@/session/renderer/lib/theme/host-theme'
import { resolvePalette } from '@/session/renderer/lib/theme/theme-packs'
import { BUILTIN_THEME_PACKS } from '@/session/renderer/lib/theme/builtin-theme-packs'
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
