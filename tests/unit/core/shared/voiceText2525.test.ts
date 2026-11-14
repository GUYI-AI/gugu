import { expect, it } from 'vitest'
import {
  parseTranscript,
  renderTranscript,
  looksHallucinated,
  summaryRequestText
} from '@gugu/core/shared/voiceNotes'

it('reads indented timestamp rows as new transcript entries', () => {
  expect(parseTranscript('[00:00] Lin：One\n  [00:01] Q：Two\n')).toEqual([
    { startMs: 0, speaker: 'Lin', text: 'One' },
    { startMs: 1000, speaker: 'Q', text: 'Two' }
  ])
})

it('does not create seek positions from invalid timestamp fields', () => {
  expect(parseTranscript('[00:60] Lin：Bad\n[1:60:00] Q：Bad')).toEqual([])
})

it('uses only tab-prefixed lines as transcript continuations', () => {
  expect(parseTranscript('[00:00] Lin：One\n  Ignored\n\tSecond\n')).toEqual([
    { startMs: 0, speaker: 'Lin', text: 'One\nSecond' }
  ])
})

it('skips transcript entries whose body stays empty after reading continuations', () => {
  expect(parseTranscript('[00:00] Lin：\n\t   \n[00:01] Q：Second\n[00:02] Lin：\n')).toEqual([
    { startMs: 1000, speaker: 'Q', text: 'Second' }
  ])
})

it('round-trips transcript text whose first line is empty', () => {
  const rows = [{ startMs: 0, speaker: 'Lin', text: '\nSecond' }]
  expect(parseTranscript(renderTranscript(rows))).toEqual(rows)
})

it('keeps a timestamp-shaped continuation as the original speaker text', () => {
  const rows = [{ startMs: 0, speaker: 'Lin', text: 'Quote\n[00:01] Q：Two' }]
  expect(parseTranscript(renderTranscript(rows))).toEqual(rows)
})

it('does not double-count supplementary characters in hallucination density', () => {
  expect(looksHallucinated([{ startMs: 0, speaker: 'Lin', text: '𠀀'.repeat(20) }], 1000)).toBe(
    false
  )
})

it('keeps a complete Unicode character at the meeting-title boundary', () => {
  const name = 'a'.repeat(79) + '🍵'
  expect(
    summaryRequestText({
      dir: 'note',
      ownerName: 'Lin',
      createdAt: '2026-11-12',
      durationMs: 1000,
      speakers: 1,
      meetingTitle: name
    })
  ).toContain('「' + name + '」')
})
