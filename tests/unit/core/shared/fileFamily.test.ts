// fileFamily: the one judgement every file icon reads (packages/session-shared/src/file-marks.ts draws it).
import { describe, expect, test } from 'vitest'
import { fileFamily } from '@gugu/core/shared/fileFamily.mjs'
import { fileTile } from '@gugu/session-shared/file-marks'

const CASES: [string, string, string][] = [
  ['report.pdf', '', 'pdf'], ['brief.DOCX', '', 'word'], ['budget.xlsx', '', 'sheet'], ['data.csv', '', 'sheet'],
  ['deck.pptx', '', 'slides'], ['archive.zip', '', 'archive'], ['logs.tar.gz', '', 'archive'], ['photo.png', '', 'image'],
  ['clip.mov', '', 'video'], ['voice.m4a', '', 'audio'], ['analyze.py', '', 'code'], ['notes.md', '', 'text'],
  ['config.yaml', '', 'text'], ['page.html', '', 'text'], ['scan', 'application/pdf', 'pdf'], ['shot', 'image/png; q=1', 'image'],
  ['notes', 'text/markdown', 'text'], ['photo.png', 'application/octet-stream', 'image'], ['mystery.bin', 'application/zip', 'archive'],
  ['mystery.bin', '', 'other'], ['', '', 'other'], ['dir/a.b/README', '', 'other'],
]

describe('fileFamily', () => {
  test.each(CASES)('%s (%s) → %s', (name, mime, family) => expect(fileFamily(name, mime)).toBe(family))

  // A tile's word (version 2 of the tile): the last suffix, else the family; a claim's long suffix by its last part.
  test('a tile is the family with its suffix as its word', () => {
    const tile = (name: string, mime?: string) => { const { family, label } = fileTile(name, mime); return [family, label] }
    expect(tile('Q3 report.PDF', 'application/pdf')).toEqual(['pdf', 'PDF'])
    expect(tile('model.tar.gz')).toEqual(['archive', 'GZ'])
    expect(tile('a.vote.json', 'application/json')).toEqual(['text', 'JSON'])
    expect(tile('README', 'image/png')).toEqual(['image', 'IMAG'])
    expect(tile('blob', 'application/octet-stream')).toEqual(['other', ''])
    expect(fileTile('budget.xlsx').color).toBe('var(--file-sheet)')
  })
})
