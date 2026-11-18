import { describe, expect, it } from 'vitest'
import { buildBubbleStyle } from '../../../../apps/desktop/src/components/chat/messageBubbleStyle'

// In dark my bubble is the same grey as --muted, so what fills inside it reads --muted from the bubble's own text.
describe('a fill inside my bubble', () => {
  const muted = (style: object) => (style as Record<string, unknown>)['--muted']
  it('is mixed from the bubble text in my bubble', () => {
    expect(muted(buildBubbleStyle(true, false, false))).toBe('color-mix(in oklab, currentColor 10%, transparent)')
  })
  it('stays the page fill in theirs and in a whisper (whose own background is --muted)', () => {
    expect(muted(buildBubbleStyle(false, false, false))).toBeUndefined()
    expect(muted(buildBubbleStyle(true, true, false))).toBeUndefined()
  })
})
