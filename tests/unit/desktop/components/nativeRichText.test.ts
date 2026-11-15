import { describe, expect, it } from 'vitest'
import { insertNativeListMarkers, type NativeRichText } from '../../../../apps/desktop/src/platform/nativeRichText'

function snapshot(): NativeRichText {
  return {
    text: 'First\nSecond 😀', start: 6, end: 12,
    runs: [{ start: 0, end: 6, fontSize: 16, weight: 400, italic: false, monospace: false, color: { red: 24, green: 24, blue: 24, alpha: 1 } },
      { start: 6, end: 15, fontSize: 16, weight: 700, italic: false, monospace: false, color: { red: 24, green: 24, blue: 24, alpha: 1 } }],
    paragraphs: [{ start: 0, end: 5, lineHeight: 24, before: 0, after: 0, indent: 24, firstLineIndent: 0, marker: '1.' },
      { start: 6, end: 15, lineHeight: 24, before: 0, after: 0, indent: 24, firstLineIndent: 0, marker: '2.' }],
    blocks: [{ start: 6, end: 15, background: { red: 240, green: 240, blue: 240, alpha: 1 }, insetLeft: 24, insetRight: 0, paddingTop: 8, paddingBottom: 8, radius: 8, trailingSpacing: 0 }],
  }
}

describe('native rich text UTF-16 offsets', () => {
  it('inserts visible list markers without changing the selected word or emoji', () => {
    const original = snapshot()
    const rich = insertNativeListMarkers(original)
    expect(rich.text).toBe('1.\tFirst\n2.\tSecond 😀')
    expect(rich.text.slice(rich.start, rich.end)).toBe('Second')
    expect(rich.text.slice(rich.runs[1].start, rich.runs[1].end)).toBe('Second 😀')
    expect(original.text).toBe('First\nSecond 😀')
  })

  it('does not extend a preceding style into the next item marker at the same boundary', () => {
    const rich = insertNativeListMarkers(snapshot())
    expect(rich.text.slice(rich.runs[0].start, rich.runs[0].end)).toBe('First\n')
    expect(rich.text.slice(rich.paragraphs[1].start, rich.paragraphs[1].end)).toBe('2.\tSecond 😀')
    expect(rich.text.slice(rich.blocks[0].start, rich.blocks[0].end)).toBe('Second 😀')
  })

  it('keeps non-list text and its offsets unchanged', () => {
    const original = snapshot()
    original.paragraphs = original.paragraphs.map(({ marker: _marker, ...paragraph }) => paragraph)
    expect(insertNativeListMarkers(original)).toEqual(original)
  })
})
