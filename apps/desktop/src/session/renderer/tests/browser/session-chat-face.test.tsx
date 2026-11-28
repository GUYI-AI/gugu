// owner 11-26(GitHub 深色):会话页的页头比对话区深一档。页头画在页面那一层(--bg)上,对话区画 --chat-bg;
// 深色从前把 --chat-bg 抬到 --card,于是每一族深色主题(连咕咕默认)都差一档。两者必须同色:每一族、两种明暗。
import { afterEach, expect, it } from 'vitest'
import { sessionSkinClassName } from '@/components/sessionpage/sessionSkin'
import { writeThemePreference } from '@/session/renderer/lib/theme/host-theme'
import { BUILTIN_THEME_PACKS, chooseThemePack, resetThemePacks } from '@/session/renderer/lib/theme/theme-pack-store'
import { packModes, type ThemeMode } from '@/session/renderer/lib/theme/theme-packs'
import '@/styles/tokens.css'
import '@renderer/index.css'

afterEach(() => {
  resetThemePacks()
  localStorage.clear()
})

function paint(skin: HTMLElement, value: string): string {
  const probe = skin.appendChild(document.createElement('i'))
  probe.style.backgroundColor = value
  const out = getComputedStyle(probe).backgroundColor
  probe.remove()
  return out
}

const cases: { label: string; pack: string | null; mode: ThemeMode }[] = [
  ...(['light', 'dark'] as const).map((mode) => ({ label: 'Gugu default', pack: null, mode })),
  ...BUILTIN_THEME_PACKS.flatMap((pack) => packModes(pack).map((mode) => ({ label: pack.name, pack: pack.id, mode }))),
]

it.each(cases)('$label, $mode: the conversation is drawn on the page face its header sits on', ({ pack, mode }) => {
  if (pack) chooseThemePack(pack)
  else resetThemePacks()
  writeThemePreference(mode)
  const skin = document.body.appendChild(document.createElement('div'))
  skin.className = sessionSkinClassName(mode)
  try {
    expect(paint(skin, 'var(--chat-bg)')).toBe(paint(skin, 'var(--bg)'))
  } finally {
    skin.remove()
  }
})
