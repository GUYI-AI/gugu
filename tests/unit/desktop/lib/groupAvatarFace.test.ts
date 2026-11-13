import { describe, expect, it } from 'vitest'
import { GROUP_AVATAR_COLORS, groupAvatarColor, groupAvatarSvg, groupAvatarTextLines } from '@gugu/core/shared/ui/groupAvatar'

describe('default group face', () => {
  it('gives a group one of the eight colours, the same one every time', () => {
    const color = groupAvatarColor('3f6c1a52-chat')
    expect(GROUP_AVATAR_COLORS).toContain(color)
    expect(groupAvatarColor('3f6c1a52-chat')).toBe(color)
    expect(new Set(Array.from({ length: 200 }, (_, index) => groupAvatarColor(`chat-${index}`))).size).toBe(GROUP_AVATAR_COLORS.length)
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

  it('draws the group mark without text and the text in its place, sized by how many characters show', () => {
    const mark = groupAvatarSvg({ color: '#3370FF', fill: '#fff' })
    expect(mark).not.toContain('<text')
    expect(mark).toContain('stroke="#3370FF"')
    const sizeOf = (text: string) => /font-size="(\d+)"/.exec(groupAvatarSvg({ color: '#3370FF', text, fill: '#fff' }))?.[1]
    expect([sizeOf('团'), sizeOf('团队'), sizeOf('MKT'), sizeOf('产品设计'), sizeOf('Branding')]).toEqual(['116', '92', '72', '72', '60'])
    expect(groupAvatarSvg({ color: '#3370FF', text: '<b>&', fill: '#fff' })).toContain('&#60;b&#62;&#38;')
  })
})
