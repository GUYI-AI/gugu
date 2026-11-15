// @vitest-environment jsdom
// 资源库「主题」的两个槽位(深色时 / 浅色时各用哪族)与明暗偏好的配合(owner 11-07 拍板:单模式主题顺手切明暗)。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readThemePreference, writeThemePreference } from '../../../../apps/desktop/src/session/renderer/lib/theme/host-theme'
import {
  applyThemePackSlots,
  chooseThemePack,
  readThemePackSlots,
  removeImportedThemePack,
  resetThemePacks,
  restoreThemePackChoice,
  saveImportedThemePack,
  subscribeToThemePacks,
  THEME_PACK_CSS_KEY,
  THEME_PACK_SLOTS_KEY,
  THEME_PACK_STYLE_ID,
} from '../../../../apps/desktop/src/session/renderer/lib/theme/theme-pack-store'
import type { ThemePack } from '../../../../apps/desktop/src/session/renderer/lib/theme/theme-packs'

const style = () => document.getElementById(THEME_PACK_STYLE_ID)

const imported: ThemePack = {
  id: 'obsidian:someone/paper',
  name: 'Paper',
  modes: { light: { bg: '#fbf7ef', fg: '#2b2a28' } },
  source: { kind: 'obsidian', url: 'https://github.com/someone/paper', author: 'someone', license: '' },
}

beforeEach(() => {
  localStorage.clear()
  document.head.innerHTML = ''
  writeThemePreference('light')
})
afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.themePreference
})

describe('theme pack slots', () => {
  it('a light & dark family fills both slots and leaves the light/dark preference alone', () => {
    chooseThemePack('catppuccin')
    expect(readThemePackSlots()).toEqual({ dark: 'catppuccin', light: 'catppuccin' })
    expect(readThemePreference()).toBe('light')
    expect(style()?.textContent).toContain(":root[data-theme='dark']")
    expect(style()?.textContent).toContain(":root[data-theme='light']")
    // 引导脚本首帧前插的就是这一段。
    expect(localStorage.getItem(THEME_PACK_CSS_KEY)).toBe(style()?.textContent)
  })

  it('a dark-only family fills only the dark slot and switches to dark so the click is visible; undo restores both', () => {
    chooseThemePack('github')
    const before = chooseThemePack('dracula')
    expect(readThemePackSlots()).toEqual({ dark: 'dracula', light: 'github' })
    expect(readThemePreference()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    restoreThemePackChoice(before)
    expect(readThemePackSlots()).toEqual({ dark: 'github', light: 'github' })
    expect(readThemePreference()).toBe('light')
  })

  it('reset goes back to the Gugu default: no stylesheet, nothing cached for first paint', () => {
    chooseThemePack('gruvbox')
    resetThemePacks()
    expect(readThemePackSlots()).toEqual({})
    expect(style()).toBeNull()
    expect(localStorage.getItem(THEME_PACK_CSS_KEY)).toBeNull()
  })

  it('imported packs join the list; removing one empties the slot that pointed at it', () => {
    let notified = 0
    const off = subscribeToThemePacks(() => { notified += 1 })
    saveImportedThemePack(imported)
    chooseThemePack(imported.id)
    expect(readThemePackSlots()).toEqual({ light: imported.id })
    removeImportedThemePack(imported.id)
    expect(readThemePackSlots()).toEqual({})
    expect(notified).toBeGreaterThanOrEqual(3)
    off()
  })

  it('a slot pointing at something that no longer exists reads as the default, and stale storage is ignored', () => {
    localStorage.setItem(THEME_PACK_SLOTS_KEY, JSON.stringify({ dark: 'gone', light: 'tokyo-night' }))
    expect(readThemePackSlots()).toEqual({ light: 'tokyo-night' })
    localStorage.setItem(THEME_PACK_SLOTS_KEY, '{not json')
    expect(readThemePackSlots()).toEqual({})
    applyThemePackSlots()
    expect(style()).toBeNull()
  })

  it('index.html first-paint script uses the same storage key and style id', () => {
    const html = readFileSync(join(__dirname, '../../../../apps/desktop/index.html'), 'utf8')
    expect(html).toContain(`localStorage.getItem('${THEME_PACK_CSS_KEY}')`)
    expect(html).toContain(`style.id = '${THEME_PACK_STYLE_ID}'`)
  })
})
