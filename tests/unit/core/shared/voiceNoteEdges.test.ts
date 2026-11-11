import { describe, expect, it } from 'vitest'
import { exportFileName, parseTranscript, renderTranscript, summaryTitle, transcriptTail } from '@gugu/core/shared/voiceNotes'

describe('voice-note text boundaries', () => {
  it('exports portable filenames without splitting Unicode or using device names', () => {
    expect(exportFileName('CON')).toBe('_CON.md')
    expect(exportFileName('a'.repeat(119) + '🍵')).toBe('a'.repeat(119) + '🍵.md')
    expect(exportFileName('note\nname')).toBe('notename.md')
  })
  it('does not cut a summary title inside a Unicode code point', () => {
    const title = 'a'.repeat(199) + '🍵'
    expect(summaryTitle('# ' + title)).toBe(title)
  })
  it('keeps continuation lines when reloading a rendered transcript', () => {
    const lines = [{ startMs: 0, speaker: 'Lin', text: 'Hello\nworld' }]
    expect(parseTranscript(renderTranscript(lines))).toEqual(lines)
  })
  it('returns an empty transcript tail when zero lines are requested', () => {
    expect(transcriptTail([{ startMs: 0, speaker: 'Lin', text: 'Hello' }], 0)).toBe('')
  })
  it('round-trips timestamps beyond 99 hours', () => {
    const lines = [{ startMs: 360_005_000, speaker: 'Lin', text: 'Hello' }]
    expect(parseTranscript(renderTranscript(lines))).toEqual(lines)
  })
})
