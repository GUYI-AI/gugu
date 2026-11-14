import { describe, expect, it } from 'vitest'
import { groupAvatarColorIndex, groupAvatarDefaultText, groupAvatarSvg, groupAvatarTextLines, groupAvatarThemeColor } from '@gugu/core/shared/ui/groupAvatar'

describe('default group face', () => {
  it('gives a group one of the eight colours, the same one every time', () => {
    const index = groupAvatarColorIndex('3f6c1a52-chat')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(8)
    expect(groupAvatarColorIndex('3f6c1a52-chat')).toBe(index)
    expect(new Set(Array.from({ length: 200 }, (_, n) => groupAvatarColorIndex(`chat-${n}`))).size).toBe(8)
    expect(groupAvatarThemeColor(index)).toBe(`var(--group-face-${index + 1})`)
  })

  it.each([
    ['Branding', 'Br'], ['Design Review', 'DR'], ['a b c d e', 'AB'],
    ['MKT', 'MK'], ['市场部', '市场'], ['产品设计', '产品'], ['AI研发', 'AI'],
    ['周末 去杭州', '周末'], ['', ''], ['   ', ''],
    ['🚀发布', '🚀发'], ['👩‍💻研发', '👩‍💻研'], ['🇨🇳研发', '🇨🇳研'],
    ['!发布', '!发'], ['!Design Review', '!D'], ['A 团', 'A团'],
  ])('takes at most two visible graphemes: %s → %s', (name, expected) => {
    expect(groupAvatarDefaultText(name)).toBe(expected)
    expect(groupAvatarTextLines(name)).toEqual(expected ? [expected] : [])
  })

  it('draws a circular outline around the text, or around the group mark when there is none', () => {
    const mark = groupAvatarSvg({ color: '#3370FF', fill: '#fff', px: 64 })
    expect(mark).not.toContain('<text')
    expect(mark).toMatch(/<circle cx="104" cy="104" r="[\d.]+"[^>]*stroke="#3370FF"/)
    const sizeOf = (text: string) => /font-size="(\d+)"/.exec(groupAvatarSvg({ color: '#3370FF', text, fill: '#fff', px: 64 }))?.[1]
    expect([sizeOf('团'), sizeOf('团队'), sizeOf('MKT'), sizeOf('产品设计'), sizeOf('Branding')]).toEqual(['116', '80', '80', '80', '80'])
    expect(sizeOf('WWWW')).toBe('80')
    expect(sizeOf('mmmm')).toBe('80')
    expect(sizeOf('AI研发')).toBe('80')
    expect(sizeOf('🚀')).toBe('76')
    expect(sizeOf('👩‍💻研发')).toBe('50')
    expect(groupAvatarSvg({ color: '#3370FF', text: '&<', fill: '#fff', px: 64 })).toContain('&#38;&#60;')
  })

  it('keeps the outline readable and draws text only from 24px, always on one line', () => {
    const strokeOf = (px: number) => Number(/stroke-width="([\d.]+)"/.exec(groupAvatarSvg({ color: '#3370FF', fill: '#fff', px }))![1])
    expect(strokeOf(208)).toBe(6.5)
    expect(strokeOf(32) * 32 / 208).toBeCloseTo(1.5)
    const texts = (px: number) => groupAvatarSvg({ color: '#3370FF', text: '产品讨论', fill: '#fff', px }).match(/<text/g)?.length
    expect([texts(20), texts(24), texts(28), texts(32), texts(48)]).toEqual([undefined, 1, 1, 1, 1])
    expect(/font-size="(\d+)"/.exec(groupAvatarSvg({ color: '#3370FF', text: '产品讨论', fill: '#fff', px: 32 }))?.[1], 'sized for the one line shown').toBe('80')
  })
})


describe('circular avatar text room', () => {
  it.each([24, 28, 32, 48, 96])('reserves room for single/double characters and wide WW at %spx', (px) => {
    for (const text of ['团', '宣传', 'WW', '🚀', '👩‍💻研', '👩‍💻🚀', '🇨🇳研']) {
      const svg = groupAvatarSvg({ color: '#3370FF', text, fill: '#fff', px })
      const size = Number(/font-size="(\d+)"/.exec(svg)![1])
      const stroke = Number(/stroke-width="([\d.]+)"/.exec(svg)![1])
      const count = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length
      const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(text)
      // Color-emoji fallback has wider/taller glyph boxes than the system text face.
      const width = count * size * (emoji ? 1.5 : 1)
      const height = size * (emoji ? 1.65 : 1.25)
      expect(Math.hypot(width / 2, height / 2)).toBeLessThan((208 - stroke) / 2)
      expect(svg.match(/<text/g)).toHaveLength(1)
      expect(svg).toContain('x="104" y="104"')
    }
  })
})
