// fileFamily: the one judgement every file icon reads (packages/session-shared/src/file-marks.ts draws it).
import { describe, expect, test } from 'vitest'
import { fileFamily } from '@gugu/core/shared/fileFamily.mjs'
import { FILE_MARKS, fileTile } from '@gugu/session-shared/file-marks'

const CASES: [string, string, string][] = [
  ['report.pdf', '', 'pdf'], ['brief.DOCX', '', 'word'], ['budget.xlsx', '', 'sheet'], ['data.csv', '', 'sheet'],
  ['deck.pptx', '', 'slides'], ['archive.zip', '', 'archive'], ['logs.tar.gz', '', 'archive'], ['photo.png', '', 'image'],
  ['clip.mov', '', 'video'], ['voice.m4a', '', 'audio'], ['analyze.py', '', 'code'], ['index.mjs', '', 'code'], ['styles.css', '', 'code'], ['App.vue', '', 'code'], ['notes.md', '', 'text'],
  ['config.yaml', '', 'text'], ['page.html', '', 'text'], ['scan', 'application/pdf', 'pdf'], ['shot', 'image/png; q=1', 'image'],
  ['notes', 'text/markdown', 'text'], ['photo.png', 'application/octet-stream', 'image'], ['mystery.bin', 'application/zip', 'archive'],
  ['mystery.bin', '', 'other'], ['', '', 'other'], ['dir/a.b/README', '', 'other'],
]

describe('fileFamily', () => {
  test.each(CASES)('%s (%s) → %s', (name, mime, family) => expect(fileFamily(name, mime)).toBe(family))

  // A tile is its family's glyph and colour, nothing more (the owner chose the glyph on a wash, not a suffix word).
  test('a tile is the family\'s mark', () => {
    expect(fileTile('Q3 report.PDF', 'application/pdf')).toEqual({ family: 'pdf', ...FILE_MARKS.pdf })
    expect(fileTile('a.vote.json', 'application/json')).toEqual({ family: 'text', ...FILE_MARKS.text })
    expect(fileTile('budget.xlsx').color).toBe('var(--file-sheet)')
  })
})
