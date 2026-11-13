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

  it('fits text into two lines of two full-width or four half-width characters', () => {
    expect(groupAvatarTextLines('')).toEqual([])
    expect(groupAvatarTextLines('MKT')).toEqual(['MKT'])
    expect(groupAvatarTextLines('Branding')).toEqual(['Bran', 'ding'])
    expect(groupAvatarTextLines('市场部')).toEqual(['市场', '部'])
    expect(groupAvatarTextLines('产品设计评审')).toEqual(['产品', '设计'])
    expect(groupAvatarTextLines('  Digital Marketing ')).toEqual(['Digi', 'tal'])
    expect(groupAvatarTextLines('🚀发布')).toEqual(['🚀发', '布'])
  })

  it('shows the name by default, or the initials of a name of several Latin words', () => {
    expect(groupAvatarDefaultText('产品讨论群')).toBe('产品讨论群')
    expect(groupAvatarDefaultText('MKT')).toBe('MKT')
    expect(groupAvatarDefaultText('Design Review')).toBe('DR')
    expect(groupAvatarDefaultText('  a b c d e ')).toBe('ABCD')
    expect(groupAvatarDefaultText('周末 去杭州')).toBe('周末 去杭州')
    expect(groupAvatarDefaultText('')).toBe('')
  })

  it('draws a rounded square outline around the text, or around the group mark when there is none', () => {
    const mark = groupAvatarSvg({ color: '#3370FF', fill: '#fff', px: 64 })
    expect(mark).not.toContain('<text')
    expect(mark).toMatch(/<rect [^>]*rx="[\d.]+"[^>]*stroke="#3370FF"/)
    const sizeOf = (text: string) => /font-size="(\d+)"/.exec(groupAvatarSvg({ color: '#3370FF', text, fill: '#fff', px: 64 }))?.[1]
    expect([sizeOf('团'), sizeOf('团队'), sizeOf('MKT'), sizeOf('产品设计'), sizeOf('Branding')]).toEqual(['116', '92', '72', '72', '60'])
    expect(groupAvatarSvg({ color: '#3370FF', text: '<b>&', fill: '#fff', px: 64 })).toContain('&#60;b&#62;&#38;')
  })

  it('keeps the outline a pixel and a half wide and drops the second line, then the text, where a face is small', () => {
    const strokeOf = (px: number) => Number(/stroke-width="([\d.]+)"/.exec(groupAvatarSvg({ color: '#3370FF', fill: '#fff', px }))![1])
    expect(strokeOf(208)).toBe(6.5)
    expect(strokeOf(32) * 32 / 208).toBeCloseTo(1.5)
    const texts = (px: number) => groupAvatarSvg({ color: '#3370FF', text: '产品讨论', fill: '#fff', px }).match(/<text/g)?.length
    expect([texts(20), texts(24), texts(32), texts(40)]).toEqual([undefined, 1, 1, 2])
    expect(/font-size="(\d+)"/.exec(groupAvatarSvg({ color: '#3370FF', text: '产品讨论', fill: '#fff', px: 32 }))?.[1], 'sized for the one line shown').toBe('92')
  })
})
