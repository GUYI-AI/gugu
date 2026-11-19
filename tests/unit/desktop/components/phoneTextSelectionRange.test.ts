import { describe, expect, it } from 'vitest'
import { phoneTextWordRange } from '../../../../apps/desktop/src/components/chat/phoneTextSelectionRange'

function picked(text: string, offset: number) {
  const range = phoneTextWordRange(text, offset)
  return range && text.slice(range.start, range.end)
}

describe('initial mobile text selection', () => {
  it('starts with the pressed word rather than the complete message', () => {
    expect(picked('The harbor opens at sunrise.', 7)).toBe('harbor')
    expect(picked('The harbor opens at sunrise.', 14)).toBe('opens')
    expect(picked('harbor,opens', 7)).toBe('opens')
  })

  it('keeps UTF-16 offsets after emoji and preserves a joined emoji', () => {
    const text = '👩‍💻 harbor opens'
    expect(picked(text, 3)).toBe('👩‍💻')
    expect(picked(text, text.indexOf('harbor') + 2)).toBe('harbor')
  })

  it('selects a Chinese word around the press without swallowing the message', () => {
    const text = '今天下午开会，请准时参加。'
    const range = phoneTextWordRange(text, 3)!
    expect(range.start).toBeLessThanOrEqual(3)
    expect(range.end).toBeGreaterThan(3)
    expect(text.slice(range.start, range.end)).toBe('下午')
    expect(range.end - range.start).toBeLessThan(text.length)
  })

  it('chooses nearby text for spacing and clamps positions at either edge', () => {
    expect(picked('  harbor opens  ', 0)).toBe('harbor')
    expect(picked('  harbor opens  ', 500)).toBe('opens')
    expect(picked('harbor opens', 6)).toBe('harbor')
    expect(picked('harbor opens', Number.NaN)).toBe('harbor')
  })

  it('does not manufacture a selection for an empty or whitespace-only message', () => {
    expect(phoneTextWordRange('', 0)).toBeNull()
    expect(phoneTextWordRange(' \n\t ', 2)).toBeNull()
  })
})
