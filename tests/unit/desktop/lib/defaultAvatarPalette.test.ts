import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AVATAR_FEATURE_COLOR, AVATAR_PALETTE, BODY_COLORS, avatarColorIndex } from '@gugu/core/shared/ui/avatarPalette'
import { agentIdentity } from '../../../../apps/desktop/src/components/agentAvatar/engine/identity'
import { boringAvatarAppearance } from '../../../../apps/desktop/src/lib/agentAvatarPalette'
import { groupAvatarColorIndex } from '@gugu/core/shared/ui/groupAvatar'

const expected = [
  ['#ecdab9', '#876e3c', '#d6b676', '#826b3d', '#b8a176'],
  ['#dce0bc', '#717641', '#bac17d', '#6e7342', '#a4a97a'],
  ['#cae5c8', '#577d55', '#98ca95', '#567954', '#8db08b'],
  ['#bce7d9', '#3d806e', '#7aceb5', '#3f7c6b', '#79b2a1'],
  ['#b8e6eb', '#317e85', '#6eccd4', '#357b81', '#72b1b7'],
  ['#bee3f8', '#417996', '#7ec5eb', '#427691', '#7cacc7'],
  ['#ccddfe', '#5b719e', '#9dbbf5', '#596e98', '#8fa5ce'],
  ['#ddd7fa', '#73699a', '#bdb0f0', '#706794', '#a69dca'],
  ['#edd2ef', '#87638b', '#d7a7dc', '#836186', '#b997bc'],
  ['#f8d0df', '#945f75', '#e9a3bf', '#8f5e72', '#c694a8'],
  ['#fbd1cd', '#99605d', '#efa49f', '#935e5b', '#ca9591'],
  ['#f7d4bf', '#946547', '#e9ab84', '#8f6347', '#c69a7f'],
]
function contrast(a: string, b: string) {
  const luminance = (hex: string) => [1, 3, 5].reduce((sum, at, i) => {
    const v = parseInt(hex.slice(at, at + 2), 16) / 255
    return sum + (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i]
  }, 0)
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + .05) / (lo + .05)
}

describe('the shared twelve-hue default avatar palette', () => {
  it('matches every approved light/dark body, background and human shade', () => {
    expect(BODY_COLORS.map(c => c.en.toLowerCase())).toEqual(['cream', 'matcha', 'sprout', 'mint', 'lagoon', 'sky', 'haze', 'lavender', 'lilac', 'sakura', 'peach', 'apricot'])
    expect(AVATAR_PALETTE.map(({ light: l, dark: d }) => [l.body, l.background, d.body, d.background, d.human])).toEqual(expected)
    for (const { light, dark } of AVATAR_PALETTE) {
      expect(light.human).toBe(light.body)
      expect(light.groupFill).toBe(light.body)
      for (const color of [...Object.values(light), ...Object.values(dark)]) expect(color).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('keeps deterministic identity assignment, uses all twelve hues and preserves beam geometry seeds', () => {
    const agentHues = new Set<number>(), groupHues = new Set<number>()
    for (let i = 0; i < 400; i++) {
      const id = `avatar-identity-${i}`, index = avatarColorIndex(id)
      agentHues.add(index); groupHues.add(groupAvatarColorIndex(id))
      expect(avatarColorIndex(` ${id} `)).toBe(index)
      expect(agentIdentity(id).color).toBe(index)
      let original = 0
      for (const c of id) original = ((original << 5) - original + c.charCodeAt(0)) | 0
      for (const theme of ['light', 'dark'] as const) {
        const appearance = boringAvatarAppearance(id, theme)
        expect(appearance.seed).toBe(Math.abs(original))
        expect(appearance.body).toBe(AVATAR_PALETTE[index][theme].body)
      }
    }
    expect(agentHues.size).toBe(12); expect(groupHues.size).toBe(12)
    expect(() => avatarColorIndex(' ')).toThrow('stable identity')
  })

  it.each(['light', 'dark'] as const)('meets facial and group-text contrast floors for all twelve %s hues', theme => {
    for (const family of AVATAR_PALETTE) {
      const c = family[theme]
      expect(contrast(AVATAR_FEATURE_COLOR, c.body)).toBeGreaterThanOrEqual(3)
      expect(contrast(AVATAR_FEATURE_COLOR, c.background)).toBeGreaterThanOrEqual(3)
      expect(contrast(c.groupText, c.groupFill)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('uses the same approved shades in live CSS group/project faces', () => {
    const css = readFileSync('apps/desktop/src/styles/tokens.css', 'utf8')
    for (let i = 0; i < 12; i++) {
      for (const [role, token] of [['groupFill', 'fill'], ['groupStroke', 'stroke'], ['groupText', 'text']] as const) {
        const values = [...css.matchAll(new RegExp(`--avatar-group-${token}-${i + 1}: (#[0-9a-f]{6});`, 'g'))].map(m => m[1])
        expect(values).toEqual([AVATAR_PALETTE[i].dark[role], AVATAR_PALETTE[i].light[role]])
      }
    }
    expect(css).not.toContain('--group-face-')
  })
})
