// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { groupAvatarColorIndex } from '@gugu/core/shared/ui/groupAvatar'
import { defaultGroupFaceSvg } from '../../../../apps/desktop/src/lib/chatNotificationFaces'

const theme: Record<string, string> = {}
for (let i = 1; i <= 12; i++) { theme[`--avatar-group-text-${i}`] = `#00${i.toString(16).padStart(2, '0')}aa`; theme[`--avatar-group-stroke-${i}`] = `#${i.toString(16).padStart(2, '0')}00bb` }
theme['--card'] = '#123456'
const read = (name: string) => theme[name] ?? ''

describe('defaultGroupFaceSvg', () => {
  it('is seeded by the group id, so renaming never changes its colours', () => {
    const before = defaultGroupFaceSvg({ id: 'group-7', name: 'Alpha' }, read)
    const after = defaultGroupFaceSvg({ id: 'group-7', name: 'Beta' }, read)
    const index = groupAvatarColorIndex('group-7') + 1
    for (const svg of [before, after]) {
      expect(svg).toContain(theme[`--avatar-group-text-${index}`])
      expect(svg).toContain(theme[`--avatar-group-stroke-${index}`])
    }
    expect(before).toContain('>Al<')
    expect(after).toContain('>Be<')
  })

  it('has no CSS variables left, because an SVG loaded as an image cannot see the page', () => {
    expect(defaultGroupFaceSvg({ id: 'group-7', name: 'Alpha' }, read)).not.toContain('var(')
  })

  it('sits on a solid disc so the OS can draw it over any background', () => {
    expect(defaultGroupFaceSvg({ id: 'group-7', name: 'Alpha' }, read)).toContain('<circle cx="104" cy="104" r="104" fill="#123456"/>')
  })

  it('falls back to the shared tokens when the theme cannot be read', () => {
    const svg = defaultGroupFaceSvg({ id: 'group-7', name: 'Alpha' }, () => '')
    expect(svg).not.toContain('var(')
    expect(svg).toMatch(/fill="#[0-9a-f]{6}"/)
  })
})
