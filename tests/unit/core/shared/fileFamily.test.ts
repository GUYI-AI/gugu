// fileFamily and the file icon: the family is the icon's fallback when the manifest names nothing (packages/session-shared/src/file-marks.ts).
import { describe, expect, test } from 'vitest'
import { fileFamily } from '@gugu/core/shared/fileFamily.mjs'
import { fileIconId, fileMark, folderMark } from '@gugu/session-shared/file-marks'

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
})

// The file icon (packages/session-shared/src/file-icons): manifest names > patterns > ext > the file's family > unknown.
const ICONS: [string, string, string][] = [
  ['src/app.ts', '', 'ts'], ['View.TSX', '', 'tsx'], ['index.mjs', '', 'js'], ['analyze.py', '', 'py'], ['README.md', '', 'md'],
  ['package.json', '', 'json'], ['pnpm-lock.yaml', '', 'lock'], ['config.yaml', '', 'yaml'], ['Dockerfile', '', 'docker'],
  ['Dockerfile.dev', '', 'docker'], ['api.dockerfile', '', 'docker'], ['CMakeLists.txt', '', 'code'], ['notes.txt', '', 'text'],
  ['report.pdf', '', 'pdf'], ['brief.DOCX', '', 'doc'], ['budget.xlsx', '', 'sheet'], ['deck.pptx', '', 'slides'],
  ['photo.png', '', 'image'], ['clip.mov', '', 'video'], ['voice.m4a', '', 'audio'], ['logs.tar.gz', '', 'archive'],
  ['scan', 'application/pdf', 'pdf'], ['shot', 'image/png', 'image'], ['notes', 'text/markdown', 'text'],
  ['mystery.bin', '', 'unknown'], ['', '', 'unknown'], ['C:\\work\\main.go', '', 'go'],
]

describe('fileIconId', () => {
  test.each(ICONS)('%s (%s) → %s', (name, mime, id) => expect(fileIconId(name, mime)).toBe(id))

  test('a file is drawn as its icon\'s SVG in its colour', () => {
    const mark = fileMark('budget.xlsx')
    expect(mark).toMatchObject({ id: 'sheet', color: 'var(--file-green)' })
    expect(mark.body).toContain('currentColor')
  })

  test('a folder is the set\'s folder, closed or open', () => {
    expect(folderMark()).toMatchObject({ id: 'folder', color: 'var(--file-mute)' })
    expect(folderMark(true).id).toBe('folder-open')
    expect(folderMark(true).body).not.toBe(folderMark().body)
  })
})
